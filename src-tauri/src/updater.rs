use crate::dsh::DshManager;
use crate::voice::Speech;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub configured: bool,
    pub source: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub download_url: Option<String>,
    pub release_url: Option<String>,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedVersion {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Option<String>,
}

fn parse_version(raw: &str) -> Option<ParsedVersion> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    if trimmed.is_empty() {
        return None;
    }
    let without_build = trimmed.split('+').next().unwrap_or(trimmed);
    let (core, pre) = match without_build.split_once('-') {
        Some((c, p)) => (c, (!p.is_empty()).then(|| p.to_string())),
        None => (without_build, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    Some(ParsedVersion {
        major,
        minor,
        patch,
        pre,
    })
}

pub fn is_newer_version(current: &str, candidate: &str) -> bool {
    let Some(cur) = parse_version(current) else {
        return false;
    };
    let Some(cand) = parse_version(candidate) else {
        return false;
    };
    match (
        cand.major.cmp(&cur.major),
        cand.minor.cmp(&cur.minor),
        cand.patch.cmp(&cur.patch),
    ) {
        (std::cmp::Ordering::Greater, _, _) => true,
        (std::cmp::Ordering::Less, _, _) => false,
        (_, std::cmp::Ordering::Greater, _) => true,
        (_, std::cmp::Ordering::Less, _) => false,
        (_, _, std::cmp::Ordering::Greater) => true,
        (_, _, std::cmp::Ordering::Less) => false,
        (_, _, std::cmp::Ordering::Equal) => match (&cur.pre, &cand.pre) {
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (Some(a), Some(b)) => b > a,
            (None, None) => false,
        },
    }
}

fn expand_home(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(trimmed)
}

const DEFAULT_UPDATE_URL: &str = "https://schathub.xyz/kbot/releases/latest.json";

fn normalize_endpoint(input: Option<String>) -> Option<String> {
    let explicit = input
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("KBOT_UPDATE_URL")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });

    if let Some(raw) = explicit {
        // SSH GitHub URL: "git@github.com:owner/repo.git"
        if let Some(rest) = raw.strip_prefix("git@github.com:") {
            let cleaned = rest.trim_matches('/').trim_end_matches(".git");
            let segs: Vec<&str> = cleaned.split('/').collect();
            if segs.len() == 2 && !segs[0].is_empty() && !segs[1].is_empty() {
                return Some(format!(
                    "https://api.github.com/repos/{}/{}/releases/latest",
                    segs[0], segs[1]
                ));
            }
        }
        // GitHub repo shorthand: "owner/repo" (or "owner/repo.git")
        if !raw.contains("://")
            && !raw.starts_with('/')
            && !raw.starts_with("~/")
            && !raw.starts_with('.')
            && raw.split('/').count() == 2
            && !raw.ends_with(".json")
        {
            let cleaned = raw.trim_end_matches(".git");
            return Some(format!("https://api.github.com/repos/{cleaned}/releases/latest"));
        }
        // GitHub web URL: "https://github.com/owner/repo", ".../repo.git", or ".../releases"
        if let Some(rest) = raw
            .strip_prefix("https://github.com/")
            .or_else(|| raw.strip_prefix("http://github.com/"))
        {
            let segs: Vec<&str> = rest.trim_matches('/').split('/').collect();
            if segs.len() >= 2 && (segs.len() == 2 || segs.get(2) == Some(&"releases")) {
                let repo = segs[1].trim_end_matches(".git");
                return Some(format!(
                    "https://api.github.com/repos/{}/{}/releases/latest",
                    segs[0], repo
                ));
            }
        }
        // Self-hosted release directory shorthand: "https://.../releases" or "https://.../releases/"
        if (raw.starts_with("https://") || raw.starts_with("http://"))
            && !raw.contains("api.github.com/")
            && (raw.ends_with('/') || raw.ends_with("/releases"))
        {
            return Some(format!("{}/latest.json", raw.trim_end_matches('/')));
        }
        return Some(raw);
    }

    let local_default = expand_home("~/KBOT/releases/latest.json");
    if local_default.is_file() {
        return Some(local_default.to_string_lossy().into_owned());
    }
    Some(DEFAULT_UPDATE_URL.to_string())
}

fn resolve_relative_download(base_source: &str, raw_url: &str) -> String {
    let trimmed = raw_url.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("file://")
        || trimmed.starts_with('/')
        || trimmed.starts_with("~/")
    {
        return trimmed.to_string();
    }
    if base_source.starts_with("https://") || base_source.starts_with("http://") {
        if let Ok(base) = url::Url::parse(base_source) {
            if let Ok(joined) = base.join(trimmed) {
                return joined.to_string();
            }
        }
    }
    let local_base = base_source.strip_prefix("file://").unwrap_or(base_source);
    let parent = expand_home(local_base)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    parent.join(trimmed).to_string_lossy().into_owned()
}

fn score_macos_asset(name: &str) -> i32 {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".sig") || lower.ends_with(".sha256") || lower.ends_with(".txt") {
        return -1;
    }
    let ext_score = if lower.ends_with(".app.tar.gz") || lower.ends_with(".app.zip") {
        40
    } else if lower.ends_with(".dmg") {
        35
    } else if lower.ends_with(".zip") || lower.ends_with(".tar.gz") {
        25
    } else {
        return -1;
    };

    let arch = std::env::consts::ARCH; // "aarch64" or "x86_64"
    let is_arm_name = lower.contains("aarch64") || lower.contains("arm64");
    let is_x64_name = lower.contains("x86_64") || lower.contains("x64") || lower.contains("intel");
    let is_universal = lower.contains("universal") || lower.contains("darwin") || lower.contains("macos");

    if arch == "aarch64" && is_x64_name && !is_arm_name {
        return -1;
    }
    if arch == "x86_64" && is_arm_name && !is_x64_name {
        return -1;
    }

    let arch_bonus = if (arch == "aarch64" && is_arm_name) || (arch == "x86_64" && is_x64_name) {
        20
    } else if is_universal {
        10
    } else {
        5
    };
    ext_score + arch_bonus
}

pub fn parse_release_payload(payload: &Value, current_version: &str, source: &str) -> Result<UpdateCheckResult, String> {
    // 1. GitHub Releases API shape (`tag_name` + `assets`)
    if let Some(tag) = payload.get("tag_name").and_then(Value::as_str) {
        let latest = tag.trim().trim_start_matches(['v', 'V']).to_string();
        let notes = payload
            .get("body")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let pub_date = payload
            .get("published_at")
            .and_then(Value::as_str)
            .map(String::from);
        let release_url = payload
            .get("html_url")
            .and_then(Value::as_str)
            .map(String::from);

        let mut best_asset: Option<(i32, String, Option<String>)> = None;
        if let Some(assets) = payload.get("assets").and_then(Value::as_array) {
            for asset in assets {
                let Some(name) = asset.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let Some(dl) = asset.get("browser_download_url").and_then(Value::as_str) else {
                    continue;
                };
                let score = score_macos_asset(name);
                if score < 0 {
                    continue;
                }
                let digest = asset
                    .get("digest")
                    .and_then(Value::as_str)
                    .and_then(|d| d.strip_prefix("sha256:").or(Some(d)))
                    .map(|s| s.trim().to_string())
                    .filter(|s| s.len() == 64);
                if best_asset.as_ref().map(|(s, _, _)| score > *s).unwrap_or(true) {
                    best_asset = Some((score, dl.to_string(), digest));
                }
            }
        }

        let (download_url, sha256) = match best_asset {
            Some((_, dl, sha)) => (Some(dl), sha),
            None => (None, None),
        };
        let has_update = is_newer_version(current_version, &latest);

        return Ok(UpdateCheckResult {
            configured: true,
            source: source.to_string(),
            current_version: current_version.to_string(),
            latest_version: Some(latest),
            has_update,
            download_url,
            release_url,
            notes,
            pub_date,
            sha256,
        });
    }

    // 2. Direct / Tauri-compatible manifest JSON shape (`version`, `downloadUrl`/`url`, `platforms`)
    let Some(raw_ver) = payload.get("version").and_then(Value::as_str) else {
        return Err("更新清单缺少 version 或 tag_name 字段".into());
    };
    let latest = raw_ver.trim().trim_start_matches(['v', 'V']).to_string();
    let notes = payload
        .get("notes")
        .or_else(|| payload.get("body"))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let pub_date = payload
        .get("pubDate")
        .or_else(|| payload.get("pub_date"))
        .and_then(Value::as_str)
        .map(String::from);
    let release_url = payload
        .get("releaseUrl")
        .or_else(|| payload.get("html_url"))
        .and_then(Value::as_str)
        .map(String::from);

    let arch_key = if std::env::consts::ARCH == "aarch64" {
        "darwin-aarch64"
    } else {
        "darwin-x86_64"
    };
    let platform_entry = payload
        .get("platforms")
        .and_then(|p| p.get(arch_key).or_else(|| p.get("darwin-universal")).or_else(|| p.get("macos")));

    let raw_dl = payload
        .get("downloadUrl")
        .or_else(|| payload.get("url"))
        .and_then(Value::as_str)
        .or_else(|| platform_entry.and_then(|e| e.get("url")).and_then(Value::as_str));

    let download_url = raw_dl
        .map(|u| resolve_relative_download(source, u))
        .filter(|u| !u.is_empty());

    let sha256 = payload
        .get("sha256")
        .and_then(Value::as_str)
        .or_else(|| platform_entry.and_then(|e| e.get("sha256")).and_then(Value::as_str))
        .map(|s| s.trim().trim_start_matches("sha256:").to_ascii_lowercase())
        .filter(|s| s.len() == 64);

    let has_update = is_newer_version(current_version, &latest);

    Ok(UpdateCheckResult {
        configured: true,
        source: source.to_string(),
        current_version: current_version.to_string(),
        latest_version: Some(latest),
        has_update,
        download_url,
        release_url,
        notes,
        pub_date,
        sha256,
    })
}

async fn load_manifest_json(source: &str) -> Result<Value, String> {
    if source.starts_with("https://") || source.starts_with("http://") {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent(format!("KBOT/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("初始化网络请求失败: {e}"))?;
        let resp = client
            .get(source)
            .header("Accept", "application/vnd.github+json, application/json")
            .send()
            .await
            .map_err(|e| format!("请求更新源失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("更新源返回 HTTP {}", resp.status().as_u16()));
        }
        return resp
            .json::<Value>()
            .await
            .map_err(|e| format!("解析更新清单 JSON 失败: {e}"));
    }

    let path_str = source.strip_prefix("file://").unwrap_or(source);
    let path = expand_home(path_str);
    let raw = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("读取本地更新清单失败 ({}): {e}", path.display()))?;
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("解析本地更新清单 JSON 失败: {e}"))
}

#[tauri::command]
pub async fn check_app_update(endpoint: Option<String>) -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let Some(source) = normalize_endpoint(endpoint) else {
        return Ok(UpdateCheckResult {
            configured: false,
            source: String::new(),
            current_version,
            latest_version: None,
            has_update: false,
            download_url: None,
            release_url: None,
            notes: None,
            pub_date: None,
            sha256: None,
        });
    };

    let payload = match load_manifest_json(&source).await {
        Ok(val) => val,
        Err(err)
            if source.starts_with("https://api.github.com/repos/")
                && source.ends_with("/releases/latest")
                && err.contains("HTTP 404") =>
        {
            return Ok(UpdateCheckResult {
                configured: true,
                source,
                current_version: current_version.clone(),
                latest_version: Some(current_version),
                has_update: false,
                download_url: None,
                release_url: None,
                notes: None,
                pub_date: None,
                sha256: None,
            });
        }
        Err(err) => return Err(err),
    };
    parse_release_payload(&payload, &current_version, &source)
}

fn emit_progress(app: &AppHandle, stage: &str, percent: u8, message: &str) {
    let _ = app.emit(
        "updater-progress",
        json!({
            "stage": stage,
            "percent": percent,
            "message": message,
        }),
    );
}

fn compute_file_sha256(path: &Path) -> Result<String, String> {
    let out = std::process::Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(path)
        .output()
        .map_err(|e| format!("执行 shasum 校验失败: {e}"))?;
    if !out.status.success() {
        return Err("计算安装包 SHA-256 失败".into());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    stdout
        .split_whitespace()
        .next()
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| s.len() == 64)
        .ok_or_else(|| "无法解析 SHA-256 输出".into())
}

fn find_app_bundle_in_dir(dir: &Path) -> Option<PathBuf> {
    let preferred = dir.join("KBOT.app");
    if preferred.is_dir() {
        return Some(preferred);
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if p.extension().and_then(|e| e.to_str()) == Some("app") {
                return Some(p);
            }
            if let Some(nested) = find_app_bundle_in_dir(&p) {
                return Some(nested);
            }
        }
    }
    None
}

fn target_app_bundle_from_executable(exe: &Path) -> PathBuf {
    // Preserve real installations, including user Applications and custom names.
    for ancestor in exe.ancestors() {
        if ancestor.extension().and_then(|e| e.to_str()) == Some("app") {
            let parts: Vec<_> = ancestor.iter().filter_map(|part| part.to_str()).collect();
            let cargo_build = parts.windows(2).any(|p| {
                p[0] == "target" && matches!(p[1], "debug" | "release")
            }) || parts.windows(3).any(|p| {
                p[0] == "target" && matches!(p[2], "debug" | "release")
            });
            // Build outputs and read-only launches must update the installed app.
            if !cargo_build
                && !ancestor.starts_with("/Volumes")
                && !parts.contains(&"AppTranslocation")
            {
                return ancestor.to_path_buf();
            }
        }
    }
    PathBuf::from("/Applications/KBOT.app")
}

fn resolve_target_app_bundle() -> PathBuf {
    std::env::current_exe()
        .map(|exe| target_app_bundle_from_executable(&exe))
        .unwrap_or_else(|_| PathBuf::from("/Applications/KBOT.app"))
}

fn extract_app_to_staging(artifact: &Path, work_dir: &Path) -> Result<PathBuf, String> {
    let staged_dir = work_dir.join("staged");
    std::fs::create_dir_all(&staged_dir).map_err(|e| format!("创建暂存目录失败: {e}"))?;
    let staged_app = staged_dir.join("KBOT.app");

    let file_name = artifact
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if file_name.ends_with(".dmg") {
        let mnt = work_dir.join("mnt");
        std::fs::create_dir_all(&mnt).map_err(|e| format!("创建挂载目录失败: {e}"))?;
        let attach = std::process::Command::new("/usr/bin/hdiutil")
            .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
            .arg(&mnt)
            .arg(artifact)
            .output()
            .map_err(|e| format!("挂载更新镜像失败: {e}"))?;
        if !attach.status.success() {
            return Err(format!(
                "挂载 DMG 失败: {}",
                String::from_utf8_lossy(&attach.stderr).trim()
            ));
        }

        let copy_res = (|| -> Result<(), String> {
            let found_app = find_app_bundle_in_dir(&mnt)
                .ok_or_else(|| "DMG 镜像内未找到 .app 应用包".to_string())?;
            let status = std::process::Command::new("/usr/bin/ditto")
                .arg(&found_app)
                .arg(&staged_app)
                .status()
                .map_err(|e| format!("复制应用包失败: {e}"))?;
            if !status.success() {
                return Err("从 DMG 提取应用包失败".into());
            }
            Ok(())
        })();

        let _ = std::process::Command::new("/usr/bin/hdiutil")
            .args(["detach", "-force"])
            .arg(&mnt)
            .status();

        copy_res?;
    } else if file_name.ends_with(".zip") {
        let extracted = work_dir.join("extracted");
        std::fs::create_dir_all(&extracted).map_err(|e| e.to_string())?;
        let status = std::process::Command::new("/usr/bin/ditto")
            .args(["-x", "-k"])
            .arg(artifact)
            .arg(&extracted)
            .status()
            .map_err(|e| format!("解压 ZIP 更新包失败: {e}"))?;
        if !status.success() {
            return Err("解压 ZIP 更新包未成功".into());
        }
        let found_app = find_app_bundle_in_dir(&extracted)
            .ok_or_else(|| "ZIP 更新包内未找到 .app 应用包".to_string())?;
        let copy = std::process::Command::new("/usr/bin/ditto")
            .arg(&found_app)
            .arg(&staged_app)
            .status()
            .map_err(|e| e.to_string())?;
        if !copy.success() {
            return Err("暂存应用包失败".into());
        }
    } else if file_name.ends_with(".tar.gz") || file_name.ends_with(".tgz") {
        let extracted = work_dir.join("extracted");
        std::fs::create_dir_all(&extracted).map_err(|e| e.to_string())?;
        let status = std::process::Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(artifact)
            .arg("-C")
            .arg(&extracted)
            .status()
            .map_err(|e| format!("解压 tar.gz 更新包失败: {e}"))?;
        if !status.success() {
            return Err("解压 tar.gz 更新包未成功".into());
        }
        let found_app = find_app_bundle_in_dir(&extracted)
            .ok_or_else(|| "tar.gz 更新包内未找到 .app 应用包".to_string())?;
        let copy = std::process::Command::new("/usr/bin/ditto")
            .arg(&found_app)
            .arg(&staged_app)
            .status()
            .map_err(|e| e.to_string())?;
        if !copy.success() {
            return Err("暂存应用包失败".into());
        }
    } else {
        return Err(format!("不支持的更新包格式: {file_name}（请提供 .dmg、.zip 或 .app.tar.gz）"));
    }

    if !staged_app.join("Contents/Info.plist").is_file() || !staged_app.join("Contents/MacOS").is_dir() {
        return Err("更新包校验失败：缺少有效的 macOS .app 结构".into());
    }
    let _ = std::process::Command::new("/usr/bin/xattr")
        .args(["-cr"])
        .arg(&staged_app)
        .status();

    Ok(staged_app)
}

#[tauri::command]
pub async fn install_app_update(
    download_url: String,
    expected_sha256: Option<String>,
    app: AppHandle,
    dsh: State<'_, DshManager>,
    speech: State<'_, Speech>,
) -> Result<Value, String> {
    let trimmed = download_url.trim().to_string();
    if trimmed.is_empty() {
        return Err("缺少更新包下载地址".into());
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let work_dir = std::env::temp_dir().join(format!("kbot-update-{}-{ts}", std::process::id()));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .map_err(|e| format!("创建更新临时目录失败: {e}"))?;

    let artifact_name = trimmed
        .split('?')
        .next()
        .unwrap_or(&trimmed)
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("KBOT-update.dmg");
    let artifact_path = work_dir.join(artifact_name);

    // 整体进度：下载占 0～80，校验 84，解压 90，替换 96，重启 100。界面上只显示这一个数
    emit_progress(&app, "downloading", 0, "正在下载新版本…");

    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .user_agent(format!("KBOT/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("创建下载器失败: {e}"))?;
        let resp = client
            .get(&trimmed)
            .send()
            .await
            .map_err(|e| format!("下载更新包失败: {e}"))?;
        if !resp.status().is_success() {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(format!("下载更新包返回 HTTP {}", resp.status().as_u16()));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut last_pct: u8 = 0;
        let mut file = tokio::fs::File::create(&artifact_path)
            .await
            .map_err(|e| format!("创建临时安装包文件失败: {e}"))?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res.map_err(|e| format!("接收更新包数据中断: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入更新包失败: {e}"))?;
            downloaded += chunk.len() as u64;
            if total > 0 {
                let pct = ((downloaded.saturating_mul(80)) / total).min(80) as u8;
                if pct > last_pct {
                    last_pct = pct;
                    emit_progress(&app, "downloading", pct, "正在下载新版本…");
                }
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
    } else {
        let local_src = expand_home(trimmed.strip_prefix("file://").unwrap_or(&trimmed));
        if !local_src.is_file() {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err(format!("未找到本地更新包: {}", local_src.display()));
        }
        tokio::fs::copy(&local_src, &artifact_path)
            .await
            .map_err(|e| format!("复制本地更新包失败: {e}"))?;
    }

    if let Some(expected) = expected_sha256
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        emit_progress(&app, "verifying", 84, "正在校验安装包…");
        let path_clone = artifact_path.clone();
        let actual = tokio::task::spawn_blocking(move || compute_file_sha256(&path_clone))
            .await
            .map_err(|e| format!("校验任务异常: {e}"))??;
        let clean_expected = expected.trim_start_matches("sha256:").to_ascii_lowercase();
        if actual != clean_expected {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return Err("安装包 SHA-256 校验未通过，已中止安装".into());
        }
    }

    emit_progress(&app, "extracting", 90, "正在解压新版本…");
    let artifact_for_extract = artifact_path.clone();
    let work_for_extract = work_dir.clone();
    let staged_app = tokio::task::spawn_blocking(move || {
        extract_app_to_staging(&artifact_for_extract, &work_for_extract)
    })
    .await
    .map_err(|e| format!("解压任务异常: {e}"))??;

    emit_progress(&app, "installing", 96, "正在安装新版本…");
    let target_app = resolve_target_app_bundle();
    let backup_app = work_dir.join("backup-KBOT.app");
    let target_for_swap = target_app.clone();
    let work_for_cleanup = work_dir.clone();
    // Bundled Node and DSH live inside the app being replaced. Stop the owned
    // runtime and prevent the UI's reconnect timer from launching it mid-swap.
    // A failed install drops this guard and permits reconnecting the old core.
    let mut runtime_update = dsh.suspend_for_update().await;

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if target_for_swap.exists() {
            std::fs::rename(&target_for_swap, &backup_app).map_err(|e| {
                format!(
                    "无法替换 {}（请确认当前用户对 /Applications 有写入权限）: {e}",
                    target_for_swap.display()
                )
            })?;
        }
        let copy_status = std::process::Command::new("/usr/bin/ditto")
            .arg(&staged_app)
            .arg(&target_for_swap)
            .status();
        if !copy_status.as_ref().is_ok_and(|status| status.success()) {
            if target_for_swap.exists() {
                std::fs::remove_dir_all(&target_for_swap)
                    .map_err(|e| format!("新版本写入失败且无法清理未完成的安装；旧版本保留在 {}: {e}", backup_app.display()))?;
            }
            if backup_app.exists() {
                std::fs::rename(&backup_app, &target_for_swap)
                    .map_err(|e| format!("自动恢复失败；旧版本保留在 {}: {e}", backup_app.display()))?;
            }
            return Err("写入新版本到应用目录失败，已回滚旧版本".into());
        }
        let _ = std::fs::remove_dir_all(&work_for_cleanup);
        Ok(())
    })
    .await
    .map_err(|e| format!("安装任务异常: {e}"))??;
    runtime_update.keep_suspended();

    emit_progress(&app, "relaunching", 100, "更新完成，正在重启…");
    speech.stop_active();

    let relaunch_target = target_app.to_string_lossy().into_owned();
    let _ = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("sleep 0.7 && /usr/bin/open -n \"$1\"")
        .arg("kbot-relaunch")
        .arg(&relaunch_target)
        .spawn();

    let app_for_exit = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(260)).await;
        app_for_exit.exit(0);
    });

    Ok(json!({
        "ok": true,
        "installedTo": relaunch_target,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_preserve_the_running_installed_app_path() {
        for app in [
            "/Applications/KBOT.app",
            "/Users/example/Applications/KBOT.app",
            "/Users/example/Tools/My KBOT.app",
        ] {
            let executable = Path::new(app).join("Contents/MacOS/cyber-companion");
            assert_eq!(target_app_bundle_from_executable(&executable), Path::new(app));
        }
    }

    #[test]
    fn build_and_read_only_launches_update_the_installed_app() {
        for executable in [
            "/Users/example/kbot/src-tauri/target/debug/bundle/macos/KBOT.app/Contents/MacOS/cyber-companion",
            "/Users/example/kbot/src-tauri/target/release/bundle/macos/KBOT.app/Contents/MacOS/cyber-companion",
            "/Users/example/kbot/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/KBOT.app/Contents/MacOS/cyber-companion",
            "/Volumes/KBOT/KBOT.app/Contents/MacOS/cyber-companion",
            "/private/var/folders/example/AppTranslocation/random/d/KBOT.app/Contents/MacOS/cyber-companion",
            "/Users/example/kbot/src-tauri/target/debug/cyber-companion",
        ] {
            assert_eq!(
                target_app_bundle_from_executable(Path::new(executable)),
                Path::new("/Applications/KBOT.app"),
                "launching from {executable} must not update a build or mounted copy"
            );
        }
    }

    #[test]
    fn compares_semver_and_prereleases_accurately() {
        assert!(is_newer_version("0.1.7", "0.1.8"));
        assert!(is_newer_version("0.1.8", "v0.2.0"));
        assert!(is_newer_version("0.1.8", "1.0.0"));
        assert!(!is_newer_version("0.1.8", "0.1.8"));
        assert!(!is_newer_version("0.1.8", "0.1.7"));
        assert!(is_newer_version("0.1.8-beta.1", "0.1.8"));
        assert!(!is_newer_version("0.1.8", "0.1.8-rc.1"));
        assert!(is_newer_version("0.1.8", "0.1.9-beta.1"));
    }

    #[test]
    fn normalizes_github_shorthand_and_urls() {
        assert_eq!(
            normalize_endpoint(Some("kkl800291/kbot".into())),
            Some("https://api.github.com/repos/kkl800291/kbot/releases/latest".into())
        );
        assert_eq!(
            normalize_endpoint(Some("https://github.com/kkl800291/kbot.git".into())),
            Some("https://api.github.com/repos/kkl800291/kbot/releases/latest".into())
        );
        assert_eq!(
            normalize_endpoint(Some("git@github.com:kkl800291/kbot.git".into())),
            Some("https://api.github.com/repos/kkl800291/kbot/releases/latest".into())
        );
        assert_eq!(
            normalize_endpoint(Some("https://github.com/kkl800291/kbot/releases".into())),
            Some("https://api.github.com/repos/kkl800291/kbot/releases/latest".into())
        );
        assert_eq!(
            normalize_endpoint(Some("https://cdn.example.com/kbot/latest.json".into())),
            Some("https://cdn.example.com/kbot/latest.json".into())
        );
        assert_eq!(
            normalize_endpoint(Some("https://schathub.xyz/kbot/releases".into())),
            Some("https://schathub.xyz/kbot/releases/latest.json".into())
        );
        assert_eq!(
            normalize_endpoint(Some("https://schathub.xyz/kbot/releases/".into())),
            Some("https://schathub.xyz/kbot/releases/latest.json".into())
        );
    }

    #[test]
    fn parses_manifest_and_github_release_payloads() {
        let manifest = json!({
            "version": "v0.1.9",
            "notes": "支持自动更新与时间线折叠",
            "pubDate": "2026-04-17T08:00:00Z",
            "downloadUrl": "KBOT_0.1.9_aarch64.dmg",
            "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        });
        let parsed = parse_release_payload(&manifest, "0.1.8", "https://updates.example.com/releases/latest.json")
            .expect("manifest parse");
        assert!(parsed.has_update);
        assert_eq!(parsed.latest_version.as_deref(), Some("0.1.9"));
        assert_eq!(
            parsed.download_url.as_deref(),
            Some("https://updates.example.com/releases/KBOT_0.1.9_aarch64.dmg")
        );
        assert_eq!(
            parsed.sha256.as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );

        let gh = json!({
            "tag_name": "v0.2.0",
            "body": "GitHub Release Notes",
            "html_url": "https://github.com/example/kbot/releases/tag/v0.2.0",
            "assets": [
                {
                    "name": "KBOT_0.2.0_x86_64.msi",
                    "browser_download_url": "https://example.com/win.msi"
                },
                {
                    "name": "KBOT_0.2.0_aarch64.dmg",
                    "browser_download_url": "https://example.com/KBOT_0.2.0_aarch64.dmg",
                    "digest": "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
                }
            ]
        });
        let gh_parsed = parse_release_payload(&gh, "0.1.8", "https://api.github.com/repos/x/y/releases/latest")
            .expect("github parse");
        assert!(gh_parsed.has_update);
        assert_eq!(gh_parsed.latest_version.as_deref(), Some("0.2.0"));
        if std::env::consts::ARCH == "aarch64" {
            assert_eq!(
                gh_parsed.download_url.as_deref(),
                Some("https://example.com/KBOT_0.2.0_aarch64.dmg")
            );
            assert_eq!(
                gh_parsed.sha256.as_deref(),
                Some("fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210")
            );
        }
    }
}
