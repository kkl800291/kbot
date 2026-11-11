use serde_json::Value;
use std::time::Duration;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "网络组件初始化失败".into())
}

#[tauri::command]
pub async fn weather_get(latitude: f64, longitude: f64) -> Result<Value, String> {
    if !latitude.is_finite()
        || latitude.abs() > 90.0
        || !longitude.is_finite()
        || longitude.abs() > 180.0
    {
        return Err("城市坐标无效".into());
    }
    client()?
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", latitude.to_string()),
            ("longitude", longitude.to_string()),
            ("current", "temperature_2m,weather_code".into()),
            (
                "daily",
                "temperature_2m_max,temperature_2m_min,precipitation_probability_max".into(),
            ),
            ("timezone", "auto".into()),
            ("forecast_days", "1".into()),
        ])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "天气暂不可用")?
        .error_for_status()
        .map_err(|_| "天气暂不可用")?
        .json()
        .await
        .map_err(|_| "天气格式无效".into())
}

#[tauri::command]
pub async fn city_search(name: String) -> Result<Value, String> {
    if name.len() > 200 {
        return Err("城市名过长".into());
    }
    client()?
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[
            ("name", name.as_str()),
            ("count", "5"),
            ("language", "zh"),
            ("format", "json"),
        ])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "城市查询失败，请检查网络")?
        .error_for_status()
        .map_err(|_| "城市查询失败")?
        .json()
        .await
        .map_err(|_| "城市查询失败".into())
}
