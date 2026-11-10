//! Local keyword index for folders the user names.
//! The index lives under the app data directory `knowledge/` and stores
//! paragraph chunks, relative paths, and modification times. No embeddings.

use crate::files::{atomic_write, authorized_root};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::Manager;

const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_CHUNK_CHARS: usize = 800;
const MAX_CHUNKS_PER_FILE: usize = 200;
const MAX_CHUNKS: usize = 4_000;
const MAX_FILES: usize = 2_000;
const DEFAULT_LIMIT: usize = 4;
const MAX_LIMIT: usize = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStats {
    pub indexed: usize,
    pub reused: usize,
    pub removed: usize,
    pub skipped: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub path: String,
    pub text: String,
    pub root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub snippets: Vec<Snippet>,
    pub missing: Vec<String>,
    pub note: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Catalog {
    folders: BTreeMap<String, String>,
}

#[derive(Default, Serialize, Deserialize)]
struct IndexFile {
    root: String,
    files: BTreeMap<String, IndexedFile>,
}

#[derive(Clone, Serialize, Deserialize)]
struct IndexedFile {
    modified_ms: i64,
    len: u64,
    chunks: Vec<String>,
}

#[tauri::command]
pub fn knowledge_update(app: tauri::AppHandle, root: String) -> Result<UpdateStats, String> {
    let store = store_dir(&app)?;
    update_folder(&store, &root)
}

#[tauri::command]
pub fn knowledge_search(
    app: tauri::AppHandle,
    roots: Vec<String>,
    query: String,
    limit: Option<usize>,
) -> Result<SearchResult, String> {
    let store = store_dir(&app)?;
    search_store(&store, &roots, &query, limit.unwrap_or(DEFAULT_LIMIT))
}

#[tauri::command]
pub fn knowledge_remove(app: tauri::AppHandle, root: String) -> Result<(), String> {
    let store = store_dir(&app)?;
    remove_folder(&store, &root)
}

fn store_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("knowledge");
    fs::create_dir_all(&dir).map_err(|_| "无法创建知识库目录")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

pub(crate) fn update_folder(store: &Path, root: &str) -> Result<UpdateStats, String> {
    let corpus = authorized_root(&[root.to_string()], root)?;
    let corpus_key = corpus.to_string_lossy().into_owned();
    let mut catalog = load_catalog(store)?;
    let name = slot_for(&mut catalog, &corpus_key);
    let previous = read_index(&store.join(&name)).unwrap_or_default();
    let previous = if previous.root == corpus_key {
        previous.files
    } else {
        BTreeMap::new()
    };
    let found = collect_files(&corpus)?;
    let mut files = BTreeMap::new();
    let mut indexed = 0;
    let mut reused = 0;
    let mut skipped = 0;
    let mut truncated = found.len() > MAX_FILES;
    let mut total_chunks = 0;
    for (relative, path) in found.into_iter().take(MAX_FILES) {
        if total_chunks >= MAX_CHUNKS {
            truncated = true;
            skipped += 1;
            continue;
        }
        let meta = match fs::metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => meta,
            Ok(meta) if meta.is_file() => {
                skipped += 1;
                continue;
            }
            _ => {
                skipped += 1;
                continue;
            }
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_millis() as i64)
            .unwrap_or(0);
        let len = meta.len();
        if let Some(old) = previous.get(&relative) {
            if old.modified_ms == modified_ms && old.len == len {
                total_chunks += old.chunks.len();
                reused += 1;
                files.insert(relative, old.clone());
                continue;
            }
        }
        let bytes = fs::read(&path).map_err(|_| format!("无法读取 {relative}"))?;
        if bytes.contains(&0) {
            skipped += 1;
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            skipped += 1;
            continue;
        };
        let mut chunks = chunk_paragraphs(&text);
        if chunks.len() > MAX_CHUNKS_PER_FILE {
            chunks.truncate(MAX_CHUNKS_PER_FILE);
            truncated = true;
        }
        if total_chunks + chunks.len() > MAX_CHUNKS {
            let room = MAX_CHUNKS - total_chunks;
            chunks.truncate(room);
            truncated = true;
        }
        if chunks.is_empty() {
            skipped += 1;
            continue;
        }
        total_chunks += chunks.len();
        indexed += 1;
        files.insert(
            relative,
            IndexedFile {
                modified_ms,
                len,
                chunks,
            },
        );
    }
    let removed = previous
        .keys()
        .filter(|path| !files.contains_key(path.as_str()))
        .count();
    let index = IndexFile {
        root: corpus_key,
        files,
    };
    let bytes = serde_json::to_vec(&index).map_err(|_| "无法保存知识库索引")?;
    atomic_write(&store.join(&name), &bytes, 0o600)?;
    save_catalog(store, &catalog)?;
    Ok(UpdateStats {
        indexed,
        reused,
        removed,
        skipped,
        truncated,
    })
}

pub(crate) fn search_store(
    store: &Path,
    roots: &[String],
    query: &str,
    limit: usize,
) -> Result<SearchResult, String> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let catalog = load_catalog(store).unwrap_or_default();
    let needles = terms(query);
    let mut scored: Vec<(usize, Snippet)> = Vec::new();
    let mut missing = Vec::new();
    if roots.is_empty() {
        return Ok(SearchResult {
            snippets: Vec::new(),
            missing,
            note: "这次没查到本地文档。".into(),
        });
    }
    for root in roots {
        let Ok(corpus) = Path::new(root).canonicalize() else {
            missing.push(root.clone());
            continue;
        };
        let key = corpus.to_string_lossy().into_owned();
        let Some(name) = catalog.folders.get(&key) else {
            continue;
        };
        let index = read_index(&store.join(name)).unwrap_or_default();
        if index.root != key {
            continue;
        }
        for (path, file) in &index.files {
            for chunk in &file.chunks {
                let score = score_chunk(chunk, &needles);
                if score == 0 {
                    continue;
                }
                scored.push((
                    score,
                    Snippet {
                        path: path.clone(),
                        text: chunk.clone(),
                        root: key.clone(),
                    },
                ));
            }
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.path.cmp(&b.1.path))
            .then_with(|| a.1.text.cmp(&b.1.text))
    });
    scored.truncate(limit);
    let snippets: Vec<Snippet> = scored.into_iter().map(|(_, snippet)| snippet).collect();
    let note = if !missing.is_empty() {
        "这次没查到本地文档，有文件夹已被移走。".into()
    } else if snippets.is_empty() {
        "这次没查到本地文档。".into()
    } else {
        String::new()
    };
    Ok(SearchResult {
        snippets,
        missing,
        note,
    })
}

pub(crate) fn remove_folder(store: &Path, root: &str) -> Result<(), String> {
    let mut catalog = load_catalog(store).unwrap_or_default();
    let key = Path::new(root)
        .canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| root.to_string());
    let mut names = Vec::new();
    if let Some(name) = catalog.folders.remove(&key) {
        names.push(name);
    }
    if key != root {
        if let Some(name) = catalog.folders.remove(root) {
            names.push(name);
        }
    }
    // A moved folder can no longer be canonicalized. Drop catalog entries whose
    // directory is gone when the caller passed that exact stored path.
    catalog.folders.retain(|stored, name| {
        let gone = !Path::new(stored).exists();
        let named = stored == root || stored == &key;
        if gone && named {
            names.push(name.clone());
            false
        } else {
            true
        }
    });
    for name in names {
        let _ = fs::remove_file(store.join(name));
    }
    if catalog.folders.is_empty() {
        let _ = fs::remove_file(store.join("catalog.json"));
        return Ok(());
    }
    save_catalog(store, &catalog)
}

fn collect_files(root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    walk(root, root, &mut visited, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files.dedup_by(|a, b| a.0 == b.0);
    Ok(files)
}

fn walk(
    root: &Path,
    dir: &Path,
    visited: &mut HashSet<PathBuf>,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    let canon = dir.canonicalize().map_err(|_| "无法读取文件夹")?;
    if !canon.starts_with(root) || !visited.insert(canon.clone()) {
        return Ok(());
    }
    let entries = fs::read_dir(&canon).map_err(|_| "无法读取文件夹")?;
    for entry in entries {
        let entry = entry.map_err(|_| "无法读取文件夹")?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if name_text.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|_| "无法读取文件信息")?;
        if meta.file_type().is_symlink() {
            let Ok(target) = fs::canonicalize(&path) else {
                continue;
            };
            if !target.starts_with(root) {
                continue;
            }
            if target.is_dir() {
                walk(root, &target, visited, files)?;
            } else if is_text_name(&target) {
                push_relative(root, &target, files);
            }
            continue;
        }
        if meta.is_dir() {
            walk(root, &path, visited, files)?;
        } else if meta.is_file() && is_text_name(&path) {
            push_relative(root, &path, files);
        }
    }
    Ok(())
}

fn push_relative(root: &Path, path: &Path, files: &mut Vec<(String, PathBuf)>) {
    let Ok(relative) = path.strip_prefix(root) else {
        return;
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    if relative.is_empty()
        || relative
            .split('/')
            .any(|part| part == ".." || part.starts_with('.'))
    {
        return;
    }
    files.push((relative, path.to_path_buf()));
}

fn is_text_name(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("txt" | "md" | "markdown" | "rst" | "org" | "log" | "csv")
    )
}

pub(crate) fn chunk_paragraphs(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut chunks = Vec::new();
    for paragraph in normalized.split("\n\n") {
        let paragraph = paragraph.trim();
        if paragraph.is_empty() {
            continue;
        }
        let mut rest = paragraph;
        while !rest.is_empty() {
            let count = rest.chars().count();
            if count <= MAX_CHUNK_CHARS {
                chunks.push(rest.to_string());
                break;
            }
            let end = rest
                .char_indices()
                .nth(MAX_CHUNK_CHARS)
                .map(|(index, _)| index)
                .unwrap_or(rest.len());
            let (head, tail) = rest.split_at(end);
            chunks.push(head.trim().to_string());
            rest = tail.trim_start();
        }
    }
    chunks.retain(|chunk| !chunk.is_empty());
    chunks
}

pub(crate) fn terms(query: &str) -> Vec<String> {
    let lower: Vec<char> = query.to_lowercase().chars().collect();
    let mut out = Vec::new();
    let mut ascii = String::new();
    for ch in &lower {
        if ch.is_ascii_alphanumeric() {
            ascii.push(*ch);
        } else if !ascii.is_empty() {
            out.push(std::mem::take(&mut ascii));
        }
    }
    if !ascii.is_empty() {
        out.push(ascii);
    }
    let cjk: Vec<char> = lower
        .into_iter()
        .filter(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch))
        .collect();
    if cjk.len() == 1 {
        out.push(cjk[0].to_string());
    }
    for pair in cjk.windows(2) {
        out.push(pair.iter().collect());
    }
    out.sort();
    out.dedup();
    out
}

fn score_chunk(chunk: &str, needles: &[String]) -> usize {
    if needles.is_empty() {
        return 0;
    }
    let lower = chunk.to_lowercase();
    needles
        .iter()
        .filter(|needle| lower.contains(needle.as_str()))
        .count()
}

fn slot_for(catalog: &mut Catalog, root: &str) -> String {
    if let Some(name) = catalog.folders.get(root) {
        return name.clone();
    }
    let base = format!("{:016x}", fnv64(root));
    let mut name = format!("{base}.json");
    let mut n = 1u32;
    while catalog.folders.values().any(|existing| existing == &name) {
        name = format!("{base}-{n}.json");
        n += 1;
    }
    catalog.folders.insert(root.to_string(), name.clone());
    name
}

fn fnv64(text: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn catalog_path(store: &Path) -> PathBuf {
    store.join("catalog.json")
}

fn load_catalog(store: &Path) -> Result<Catalog, String> {
    let path = catalog_path(store);
    if !path.exists() {
        return Ok(Catalog::default());
    }
    let bytes = fs::read(&path).map_err(|_| "无法读取知识库索引")?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "知识库索引损坏，可以移除文件夹后重新添加".to_string())
}

fn save_catalog(store: &Path, catalog: &Catalog) -> Result<(), String> {
    fs::create_dir_all(store).map_err(|_| "无法创建知识库目录")?;
    let bytes = serde_json::to_vec(catalog).map_err(|_| "无法保存知识库索引")?;
    atomic_write(&catalog_path(store), &bytes, 0o600)
}

fn read_index(path: &Path) -> Result<IndexFile, String> {
    let bytes = fs::read(path).map_err(|_| "无法读取知识库索引")?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "知识库索引损坏，可以移除文件夹后重新添加".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn scratch(label: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "kbot-know-{label}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    struct Guard(PathBuf);
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn incremental_index_search_and_removal() {
        let store = scratch("store");
        let corpus = scratch("corpus");
        let _store = Guard(store.clone());
        let _corpus = Guard(corpus.clone());
        fs::create_dir(corpus.join("sub")).unwrap();
        fs::write(corpus.join("sub/a.md"), "旧段落说明\n\n另一段保持").unwrap();
        fs::write(corpus.join(".secret.md"), "隐藏密钥不应该被索引").unwrap();
        let root = corpus.to_string_lossy().into_owned();
        let first = update_folder(&store, &root).unwrap();
        assert_eq!(first.indexed, 1);
        assert_eq!(first.reused, 0);
        let again = update_folder(&store, &root).unwrap();
        assert_eq!(again.indexed, 0);
        assert_eq!(again.reused, 1);
        let found = search_store(&store, &[root.clone()], "旧段落", 4).unwrap();
        assert_eq!(found.snippets.len(), 1);
        assert_eq!(found.snippets[0].path, "sub/a.md");
        assert!(found.snippets[0].text.contains("旧段落"));
        assert!(search_store(&store, &[root.clone()], "隐藏密钥", 4)
            .unwrap()
            .snippets
            .is_empty());

        fs::write(
            corpus.join("sub/a.md"),
            "新段落内容已经改写，长度也变了\n\n另一段保持",
        )
        .unwrap();
        let updated = update_folder(&store, &root).unwrap();
        assert_eq!(updated.indexed, 1);
        assert!(search_store(&store, &[root.clone()], "已经改写", 1)
            .unwrap()
            .snippets[0]
            .text
            .contains("已经改写"));
        assert!(search_store(&store, &[root.clone()], "说明", 4)
            .unwrap()
            .snippets
            .is_empty());

        let outside = scratch("outside");
        let _outside = Guard(outside.clone());
        fs::write(outside.join("leak.md"), "外部唯一标记").unwrap();
        std::os::unix::fs::symlink(outside.join("leak.md"), corpus.join("leak.md")).unwrap();
        update_folder(&store, &root).unwrap();
        assert!(search_store(&store, &[root.clone()], "外部唯一标记", 4)
            .unwrap()
            .snippets
            .is_empty());

        remove_folder(&store, &root).unwrap();
        assert!(
            !store.join("catalog.json").exists()
                || !fs::read_to_string(store.join("catalog.json"))
                    .unwrap()
                    .contains(&root)
        );
        let jsons: Vec<_> = fs::read_dir(&store)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".json") && name != "catalog.json")
            .collect();
        assert!(jsons.is_empty(), "{jsons:?}");
        let after = search_store(&store, &[root.clone()], "新段落", 4).unwrap();
        assert!(after.snippets.is_empty());

        let _ = fs::remove_dir_all(&corpus);
        let missing = search_store(&store, &[root.clone()], "新段落", 4).unwrap();
        assert!(missing.missing.iter().any(|path| path == &root));
        assert!(missing.note.contains("移走"));
    }

    #[test]
    fn paragraphs_record_relative_offsets() {
        let chunks = chunk_paragraphs("第一段足够用来检索。\n\n第二段。\r\n\r\n");
        assert_eq!(chunks.len(), 2);
        assert!(terms("知识库").contains(&"知识".to_string()));
    }
}
