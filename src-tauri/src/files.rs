//! Read and write files inside folders the frontend has authorized.
//! Paths are resolved, including symlinks, and must stay inside one authorized root.

use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_LIST: usize = 500;
const MAX_READ_BYTES: u64 = 1024 * 1024;
const MAX_READ_CHARS: usize = 32_000;
const MAX_WRITE_BYTES: usize = 1024 * 1024;

const DENIED_ROOTS: &[&str] = &[
    "/",
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/private",
    "/var",
    "/Library",
    "/Applications",
    "/Users",
    "/Volumes",
    "/opt",
    "/dev",
    "/tmp",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub kind: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirList {
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub path: String,
    pub text: String,
    pub truncated: bool,
}

#[tauri::command]
pub fn list_folder(roots: Vec<String>, root: String, path: String) -> Result<DirList, String> {
    let root = authorized_root(&roots, &root)?;
    let dir = confine(&root, &path, false)?;
    if !dir.is_dir() {
        return Err("这是文件，不是文件夹".into());
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut names = fs::read_dir(&dir)
        .map_err(|_| "无法读取文件夹")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "无法读取文件夹")?;
    names.sort_by_key(|entry| entry.file_name());
    for entry in names {
        if entries.len() >= MAX_LIST {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.contains('\0') || name.contains('/') || name.contains('\\') {
            continue;
        }
        let candidate = dir.join(&name);
        let Ok(meta) = fs::symlink_metadata(&candidate) else {
            continue;
        };
        let target = if meta.file_type().is_symlink() {
            match fs::canonicalize(&candidate) {
                Ok(target) if target.starts_with(&root) => target,
                _ => continue,
            }
        } else {
            candidate
        };
        let kind = if target.is_dir() {
            "dir"
        } else if target.is_file() {
            "file"
        } else {
            continue;
        };
        let bytes = if kind == "file" {
            target.metadata().map(|meta| meta.len()).unwrap_or(0)
        } else {
            0
        };
        entries.push(DirEntry {
            name,
            kind: kind.into(),
            bytes,
        });
    }
    Ok(DirList { entries, truncated })
}

#[tauri::command]
pub fn read_file(roots: Vec<String>, root: String, path: String) -> Result<FileText, String> {
    let root = authorized_root(&roots, &root)?;
    let file = confine(&root, &path, false)?;
    if !file.is_file() {
        return Err("这不是文件".into());
    }
    let relative = file
        .strip_prefix(&root)
        .map_err(|_| "路径不能超出授权目录")?
        .to_string_lossy()
        .replace('\\', "/");
    let len = file.metadata().map_err(|_| "无法读取文件")?.len();
    let mut bytes = fs::read(&file).map_err(|_| "无法读取文件")?;
    let mut truncated = len > MAX_READ_BYTES;
    if bytes.len() as u64 > MAX_READ_BYTES {
        bytes.truncate(MAX_READ_BYTES as usize);
        truncated = true;
    }
    if bytes.contains(&0) {
        return Err("不是文本文件".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "不是文本文件")?;
    let chars = text.chars().count();
    if chars > MAX_READ_CHARS {
        truncated = true;
        return Ok(FileText {
            path: relative,
            text: text.chars().take(MAX_READ_CHARS).collect(),
            truncated,
        });
    }
    Ok(FileText {
        path: relative,
        text,
        truncated,
    })
}

#[tauri::command]
pub fn write_file(
    roots: Vec<String>,
    root: String,
    path: String,
    content: String,
) -> Result<(), String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err("写入内容超过 1 MB".into());
    }
    let root = authorized_root(&roots, &root)?;
    let file = confine(&root, &path, true)?;
    if file.exists() && !file.is_file() {
        return Err("不能覆盖文件夹".into());
    }
    if file.exists() {
        let canon = file
            .canonicalize()
            .map_err(|_| "无法确认路径是否在授权目录内")?;
        if !canon.starts_with(&root) {
            return Err("路径不能超出授权目录".into());
        }
    }
    let mode = existing_mode(&file).unwrap_or(0o644);
    atomic_write(&file, content.as_bytes(), mode)
}

#[tauri::command]
pub fn move_file(roots: Vec<String>, root: String, from: String, to: String) -> Result<(), String> {
    let root = authorized_root(&roots, &root)?;
    let source = confine(&root, &from, false)?;
    if !source.is_file() {
        return Err("只能移动文件".into());
    }
    let dest = confine(&root, &to, true)?;
    if dest.exists() {
        return Err("目标已存在".into());
    }
    if !dest.starts_with(&root) || !source.starts_with(&root) {
        return Err("路径不能超出授权目录".into());
    }
    fs::rename(&source, &dest).map_err(|_| "无法移动文件")?;
    Ok(())
}

pub(crate) fn authorized_root(roots: &[String], root: &str) -> Result<PathBuf, String> {
    if roots.is_empty() {
        return Err("还没有授权文件夹".into());
    }
    if roots.len() > 32 {
        return Err("授权文件夹过多".into());
    }
    let wanted = Path::new(root)
        .canonicalize()
        .map_err(|_| "授权目录不存在")?;
    if !wanted.is_dir() {
        return Err("授权目录不存在".into());
    }
    if denied_root(&wanted) {
        return Err("不能把系统目录当作授权文件夹".into());
    }
    if roots
        .iter()
        .any(|candidate| Path::new(candidate).canonicalize().ok().as_ref() == Some(&wanted))
    {
        Ok(wanted)
    } else {
        Err("这个文件夹没有授权".into())
    }
}

fn denied_root(path: &Path) -> bool {
    DENIED_ROOTS.iter().any(|item| {
        let denied = Path::new(item);
        path == denied || denied.canonicalize().ok().as_deref() == Some(path)
    })
}

pub(crate) fn confine(root: &Path, rel: &str, missing_ok: bool) -> Result<PathBuf, String> {
    if rel.contains('\0') || rel.contains('\\') || rel.len() > 1024 {
        return Err("路径无效".into());
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("只能使用授权目录内的相对路径".into());
    }
    let root = if root.is_absolute() {
        root.canonicalize().map_err(|_| "授权目录不存在")?
    } else {
        return Err("授权目录不存在".into());
    };
    if !root.is_dir() || denied_root(&root) {
        return Err("授权目录不存在".into());
    }
    let mut current = root.clone();
    let comps: Vec<_> = rel_path.components().collect();
    if comps.is_empty() {
        return Ok(root);
    }
    for (index, comp) in comps.iter().enumerate() {
        let name = match comp {
            Component::Normal(name) => name,
            Component::CurDir => continue,
            Component::ParentDir => return Err("路径不能超出授权目录".into()),
            _ => return Err("路径无效".into()),
        };
        let name_text = name.to_string_lossy();
        if name_text.is_empty() || name_text.contains('/') || name_text.contains('\\') {
            return Err("路径无效".into());
        }
        current.push(name);
        let last = index + 1 == comps.len();
        match fs::symlink_metadata(&current) {
            Ok(_) => {
                let canon =
                    fs::canonicalize(&current).map_err(|_| "无法确认路径是否在授权目录内")?;
                if !canon.starts_with(&root) {
                    return Err("路径不能超出授权目录".into());
                }
                current = canon;
            }
            Err(_) if last && missing_ok => {
                let parent = current.parent().ok_or("路径无效")?;
                let parent = parent.canonicalize().map_err(|_| "上级目录不存在")?;
                if !parent.starts_with(&root) {
                    return Err("路径不能超出授权目录".into());
                }
                let file_name = current.file_name().ok_or("路径无效")?;
                current = parent.join(file_name);
            }
            Err(_) => return Err("文件不存在".into()),
        }
    }
    if !current.starts_with(&root) {
        return Err("路径不能超出授权目录".into());
    }
    Ok(current)
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or("路径无效")?;
    if !parent.is_dir() {
        return Err("上级目录不存在".into());
    }
    let tmp = parent.join(format!(
        ".kbot-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let cleanup = Tmp(&tmp);
    {
        let mut file = fs::File::create(&tmp).map_err(|_| "无法写入文件")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(mode))
                .map_err(|_| "无法设置文件权限")?;
        }
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法写入文件")?;
    }
    fs::rename(&tmp, path).map_err(|_| "无法替换文件")?;
    drop(cleanup);
    Ok(())
}

fn existing_mode(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::symlink_metadata(path)
            .ok()
            .map(|meta| meta.permissions().mode() & 0o777);
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

struct Tmp<'a>(&'a Path);
impl Drop for Tmp<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn scratch(label: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "kbot-files-{label}-{}-{}",
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

    fn roots(path: &Path) -> Vec<String> {
        vec![path.to_string_lossy().into_owned()]
    }

    #[test]
    fn rejects_parent_escape_and_unlisted_roots() {
        let root = scratch("root");
        let _guard = Guard(root.clone());
        fs::write(root.join("note.txt"), "hello").unwrap();
        let listed = roots(&root);
        let text = read_file(
            listed.clone(),
            root.to_string_lossy().into(),
            "note.txt".into(),
        )
        .unwrap();
        assert_eq!(text.text, "hello");
        assert!(read_file(
            listed.clone(),
            root.to_string_lossy().into(),
            "../note.txt".into()
        )
        .is_err());
        assert!(read_file(
            listed.clone(),
            root.to_string_lossy().into(),
            "/etc/passwd".into()
        )
        .is_err());
        let other = scratch("other");
        let _other = Guard(other.clone());
        assert!(read_file(listed, other.to_string_lossy().into(), "note.txt".into()).is_err());
    }

    #[test]
    fn symlink_escape_is_rejected_and_outside_file_stays() {
        let root = scratch("link-root");
        let outside = scratch("outside");
        let _root = Guard(root.clone());
        let _outside = Guard(outside.clone());
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("leak")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("outdir")).unwrap();
        let listed = roots(&root);
        let root_text = root.to_string_lossy().into_owned();
        assert!(read_file(listed.clone(), root_text.clone(), "leak".into()).is_err());
        assert!(read_file(
            listed.clone(),
            root_text.clone(),
            "outdir/secret.txt".into()
        )
        .is_err());
        assert!(write_file(
            listed.clone(),
            root_text.clone(),
            "leak".into(),
            "pwned".into()
        )
        .is_err());
        assert!(write_file(
            listed.clone(),
            root_text.clone(),
            "outdir/secret.txt".into(),
            "pwned".into()
        )
        .is_err());
        assert!(move_file(listed, root_text, "leak".into(), "../secret.txt".into()).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "secret"
        );
    }

    #[test]
    fn write_replaces_atomically_and_removes_temp_file() {
        let root = scratch("write");
        let _guard = Guard(root.clone());
        let listed = roots(&root);
        let root_text = root.to_string_lossy().into_owned();
        write_file(
            listed.clone(),
            root_text.clone(),
            "note.txt".into(),
            "first".into(),
        )
        .unwrap();
        write_file(
            listed.clone(),
            root_text.clone(),
            "note.txt".into(),
            "第二版完整内容".into(),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("note.txt")).unwrap(),
            "第二版完整内容"
        );
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".kbot-") || name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        fs::create_dir(root.join("nested")).unwrap();
        assert!(atomic_write(&root.join("nested"), b"nope", 0o644).is_err());
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        move_file(
            listed,
            root_text,
            "note.txt".into(),
            "nested/moved.txt".into(),
        )
        .unwrap();
        assert!(!root.join("note.txt").exists());
        assert_eq!(
            fs::read_to_string(root.join("nested/moved.txt")).unwrap(),
            "第二版完整内容"
        );
    }

    #[test]
    fn system_roots_cannot_be_authorized() {
        let err = authorized_root(&["/etc".into()], "/etc").unwrap_err();
        assert!(
            err.contains("系统目录") || err.contains("没有授权") || err.contains("不存在"),
            "{err}"
        );
    }
}
