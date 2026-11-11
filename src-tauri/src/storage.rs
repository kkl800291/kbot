use serde_json::{Map, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, State};

#[derive(Default)]
pub struct StorageLock(pub Mutex<()>);

static CREDENTIALS_LOCK: Mutex<()> = Mutex::new(());

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

fn default_credentials_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法定位用户主目录".to_string())?;
    #[cfg(target_os = "macos")]
    let dir = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join(SERVICE);
    #[cfg(not(target_os = "macos"))]
    let dir = PathBuf::from(home).join(".config").join(SERVICE);

    let file_name = if cfg!(debug_assertions) && std::env::var("COMPANION_SMOKE").as_deref() == Ok("1") {
        "credentials.smoke.json"
    } else {
        "credentials.json"
    };
    Ok(dir.join(file_name))
}

#[tauri::command]
pub fn load_state(app: tauri::AppHandle, lock: State<StorageLock>) -> Result<Value, String> {
    let _guard = lock.0.lock().map_err(|_| "存储锁不可用")?;
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let bytes = fs::read(&path).map_err(|_| "无法读取本地数据")?;
    serde_json::from_slice(&bytes).map_err(|_| {
        // Preserve damaged data for recovery rather than overwriting it on startup.
        let _ = fs::copy(&path, path.with_extension("json.recovery"));
        "本地数据损坏，已保留恢复副本。请检查数据目录后重启。".to_string()
    })
}

#[tauri::command]
pub fn save_state(
    app: tauri::AppHandle,
    data: Value,
    lock: State<StorageLock>,
) -> Result<(), String> {
    let _guard = lock.0.lock().map_err(|_| "存储锁不可用")?;
    if !data.is_object() {
        return Err("数据格式无效".into());
    }
    let bytes = serde_json::to_vec(&data).map_err(|_| "数据无法保存")?;
    if bytes.len() > 128 * 1024 * 1024 {
        return Err("本地数据超过 128 MB，请清理部分图片对话".into());
    }
    let path = state_path(&app)?;
    let temp = path.with_extension("json.tmp");
    use std::io::Write;
    let mut file = fs::File::create(&temp).map_err(|_| "无法创建本地数据文件")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置数据权限")?;
    }
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "本地数据保存失败")?;
    fs::rename(&temp, &path).map_err(|_| "本地数据替换失败".into())
}

const SERVICE: &str = "com.cybercompanion.desktop";
fn service() -> &'static str {
    if cfg!(debug_assertions) && std::env::var("COMPANION_SMOKE").as_deref() == Ok("1") {
        "com.cybercompanion.smoke"
    } else {
        SERVICE
    }
}
fn account(slot: &str) -> Result<&str, String> {
    match slot {
        "tts" | "chat" | "vision" | "search" => Ok(slot),
        _ => Err("未知的凭据类型".into()),
    }
}

fn read_vault_map(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let bytes = fs::read(path).map_err(|_| "无法读取本机凭据文件".to_string())?;
    if bytes.is_empty() {
        return Ok(Map::new());
    }
    let val: Value = serde_json::from_slice(&bytes).map_err(|_| "本机凭据文件格式异常".to_string())?;
    Ok(val.as_object().cloned().unwrap_or_default())
}

fn write_vault_map(path: &Path, map: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "无法创建本机凭据目录".to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&Value::Object(map.clone()))
        .map_err(|_| "凭据序列化失败".to_string())?;
    let temp = path.with_extension("tmp");

    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|_| "无法写入本机凭据文件".to_string())?;
        f.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置本机凭据文件权限".to_string())?;
        f
    };
    #[cfg(not(unix))]
    let mut file = fs::File::create(&temp).map_err(|_| "无法写入本机凭据文件".to_string())?;

    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "本机凭据落盘失败".to_string())?;
    fs::rename(&temp, path).map_err(|_| "本机凭据更新失败".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn vault_get_in(path: &Path, slot: &str) -> Result<Option<String>, String> {
    let map = read_vault_map(path)?;
    Ok(map
        .get(slot)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from))
}

fn vault_set_in(path: &Path, slot: &str, secret: &str) -> Result<(), String> {
    let mut map = read_vault_map(path)?;
    map.insert(slot.to_string(), Value::String(secret.trim().to_string()));
    write_vault_map(path, &map)
}

fn vault_delete_in(path: &Path, slot: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut map = read_vault_map(path)?;
    if map.remove(slot).is_some() {
        write_vault_map(path, &map)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn legacy_keychain_exists(slot: &str) -> Option<bool> {
    use security_framework::item::{ItemClass, ItemSearchOptions};
    // Metadata-only lookup: never triggers macOS authentication dialogs.
    match ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service())
        .account(slot)
        .load_attributes(true)
        .load_data(false)
        .skip_authenticated_items(true)
        .limit(1)
        .search()
    {
        Ok(items) => Some(!items.is_empty()),
        Err(error) if error.code() == -25300 => Some(false),
        Err(_) => None,
    }
}

#[cfg(target_os = "macos")]
fn cleanup_legacy_keychain(slot: &str) {
    // Deleting generic password metadata does not require reading secret bytes.
    let _ = security_framework::passwords::delete_generic_password(service(), slot);
}

pub fn read_key(slot: &str) -> Result<String, String> {
    let valid_slot = account(slot)?;
    let path = default_credentials_path()?;

    {
        let _guard = CREDENTIALS_LOCK.lock().map_err(|_| "凭据锁不可用")?;
        if let Some(found) = vault_get_in(&path, valid_slot)? {
            return Ok(found);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if legacy_keychain_exists(valid_slot) == Some(false) {
            return Err("尚未保存 API Key，请到设置中保存".to_string());
        }
        let bytes = security_framework::passwords::get_generic_password(service(), valid_slot)
            .map_err(|error| match error.code() {
                -25300 => "尚未保存 API Key，请到设置中保存".to_string(),
                -128 | -25293 | -25308 => "旧版钥匙串读取已取消；请在「设置 → 语音」中点击更换并重新保存一次 API Key，后续升级将不再弹窗".to_string(),
                _ => "无法读取旧版钥匙串，请在「设置 → 语音」中重新保存一次 API Key".to_string(),
            })?;
        let migrated = String::from_utf8(bytes).map_err(|_| "API Key 格式无效".to_string())?;
        if !migrated.trim().is_empty() {
            if let Ok(_guard) = CREDENTIALS_LOCK.lock() {
                if vault_set_in(&path, valid_slot, &migrated).is_ok() {
                    cleanup_legacy_keychain(valid_slot);
                }
            }
        }
        return Ok(migrated);
    }

    #[cfg(not(target_os = "macos"))]
    Err("尚未保存 API Key，请到设置中保存".into())
}

#[tauri::command]
pub async fn save_key(slot: String, key: String) -> Result<(), String> {
    account(&slot)?;
    if key.trim().is_empty() || key.len() > 4096 {
        return Err("请输入有效的 API Key".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = default_credentials_path()?;
        let _guard = CREDENTIALS_LOCK.lock().map_err(|_| "凭据锁不可用".to_string())?;
        vault_set_in(&path, &slot, key.trim())?;
        #[cfg(target_os = "macos")]
        cleanup_legacy_keychain(&slot);
        Ok(())
    })
    .await
    .map_err(|_| "保存凭据任务失败".to_string())?
}

#[tauri::command]
pub async fn delete_key(slot: String) -> Result<(), String> {
    account(&slot)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = default_credentials_path()?;
        let _guard = CREDENTIALS_LOCK.lock().map_err(|_| "凭据锁不可用".to_string())?;
        vault_delete_in(&path, &slot)?;
        #[cfg(target_os = "macos")]
        cleanup_legacy_keychain(&slot);
        Ok(())
    })
    .await
    .map_err(|_| "删除凭据任务失败".to_string())?
}

fn slot_has_key(map: &Map<String, Value>, slot: &str) -> Option<bool> {
    if map
        .get(slot)
        .and_then(Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        return Some(true);
    }
    #[cfg(target_os = "macos")]
    {
        return legacy_keychain_exists(slot);
    }
    #[cfg(not(target_os = "macos"))]
    Some(false)
}

#[tauri::command]
pub async fn key_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let map = default_credentials_path()
            .ok()
            .and_then(|p| {
                let _guard = CREDENTIALS_LOCK.lock().ok()?;
                read_vault_map(&p).ok()
            })
            .unwrap_or_default();
        serde_json::json!({
            "tts": slot_has_key(&map, "tts"),
            "chat": slot_has_key(&map, "chat"),
            "vision": slot_has_key(&map, "vision"),
            "search": slot_has_key(&map, "search"),
        })
    })
    .await
    .map_err(|_| "无法检查凭据状态".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_credential_vault_enforces_owner_only_permissions_and_roundtrips() {
        let tmp_dir = std::env::temp_dir().join(format!(
            "kbot-vault-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let vault_path = tmp_dir.join("credentials.json");

        assert_eq!(vault_get_in(&vault_path, "tts").unwrap(), None);
        vault_set_in(&vault_path, "tts", "  sk-mimo-secret-123  ").unwrap();
        assert_eq!(
            vault_get_in(&vault_path, "tts").unwrap().as_deref(),
            Some("sk-mimo-secret-123")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&vault_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "credentials.json must remain owner-only 0600");
        }

        vault_delete_in(&vault_path, "tts").unwrap();
        vault_delete_in(&vault_path, "tts").unwrap();
        assert_eq!(vault_get_in(&vault_path, "tts").unwrap(), None);

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
