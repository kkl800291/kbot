//! Fetch a public http(s) page and return truncated visible text.
//! Redirects are followed manually, matching `network.rs` (`redirect::Policy::none`),
//! and every hop is checked again for scheme, credentials, and private addresses.

use futures_util::StreamExt;
use serde::Serialize;
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    time::{Duration, Instant},
};
use url::{Host, Url};

const MAX_URL_LEN: usize = 2048;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_CHARS: usize = 8_000;
const MAX_REDIRECTS: usize = 5;
const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
    pub url: String,
    pub title: String,
    pub text: String,
    pub truncated: bool,
}

#[tauri::command]
pub async fn read_page(url: String) -> Result<PageText, String> {
    match tokio::time::timeout(TOTAL_TIMEOUT, fetch_page(url)).await {
        Ok(result) => result,
        Err(_) => Err("打开链接超时".into()),
    }
}

async fn fetch_page(url: String) -> Result<PageText, String> {
    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let mut current = check_url(&url)?;
    for _ in 0..=MAX_REDIRECTS {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("打开链接超时".into());
        }
        let response = send_once(&current, remaining).await?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .ok_or("重定向缺少地址")?
                .to_str()
                .map_err(|_| "重定向地址无效")?;
            current = check_redirect(&current, location)?;
            // Drop the body so the connection can close before the next hop.
            continue;
        }
        if !status.is_success() {
            return Err(format!("网页暂时打不开（HTTP {}）", status.as_u16()));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if !content_type_ok(content_type.as_deref()) {
            return Err("这个链接不是可读取的网页正文".into());
        }
        if !charset_ok(content_type.as_deref()) {
            return Err("暂时只能读取 UTF-8 网页".into());
        }
        if response.content_length().unwrap_or(0) > MAX_BYTES as u64 {
            return Err("页面过大，已拒绝".into());
        }
        let (bytes, cut) = read_limited(response).await?;
        if !meta_charset_ok(&bytes) {
            return Err("暂时只能读取 UTF-8 网页".into());
        }
        if content_type.is_none() && bytes.contains(&0) {
            return Err("这个链接不是可读取的网页正文".into());
        }
        let html = String::from_utf8_lossy(&bytes);
        let (title, text) = extract_document(&html);
        let (text, text_cut) = truncate_chars(&text, MAX_CHARS);
        let (title, _) = truncate_chars(&title, 200);
        return Ok(PageText {
            url: current.to_string(),
            title,
            text,
            truncated: cut || text_cut,
        });
    }
    Err("重定向次数过多".into())
}

async fn send_once(url: &Url, timeout: Duration) -> Result<reqwest::Response, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .user_agent("CyberCompanion/0.1");
    if let Some(Host::Domain(host)) = url.host() {
        let host = host.to_string();
        let port = url.port_or_known_default().unwrap_or(80);
        let addrs = tokio::task::spawn_blocking(move || resolve_public(&host, port))
            .await
            .map_err(|_| "无法确认链接地址，已拒绝访问")??;
        builder = builder.resolve(url.host_str().unwrap_or_default(), addrs[0]);
    }
    let client = builder.build().map_err(|_| "无法创建网络连接")?;
    client
        .get(url.clone())
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| "无法打开这个链接".to_string())
}

async fn read_limited(response: reqwest::Response) -> Result<(Vec<u8>, bool), String> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "读取页面失败")?;
        if body.len() >= MAX_BYTES {
            return Ok((body, true));
        }
        let room = MAX_BYTES - body.len();
        if chunk.len() > room {
            body.extend_from_slice(&chunk[..room]);
            return Ok((body, true));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, false))
}

pub(crate) fn check_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty()
        || raw.len() > MAX_URL_LEN
        || raw.contains('\0')
        || raw.contains('\n')
        || raw.contains('\r')
    {
        return Err("链接格式无效".into());
    }
    let url = Url::parse(raw).map_err(|_| "链接格式无效")?;
    validate_shape(&url)?;
    Ok(url)
}

pub(crate) fn check_redirect(current: &Url, location: &str) -> Result<Url, String> {
    if location.len() > MAX_URL_LEN
        || location.contains('\0')
        || location.contains('\n')
        || location.contains('\r')
    {
        return Err("重定向地址无效".into());
    }
    let next = current.join(location).map_err(|_| "重定向地址无效")?;
    validate_shape(&next)?;
    Ok(next)
}

fn validate_shape(url: &Url) -> Result<(), String> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("只接受 http 或 https 链接".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("链接不能包含账号".into());
    }
    match url.host() {
        Some(Host::Ipv4(ip)) => {
            if blocked_ip(IpAddr::V4(ip)) {
                return Err("链接指向内网或保留地址，已拒绝".into());
            }
        }
        Some(Host::Ipv6(ip)) => {
            if blocked_ip(IpAddr::V6(ip)) {
                return Err("链接指向内网或保留地址，已拒绝".into());
            }
        }
        Some(Host::Domain(host)) => {
            if blocked_domain(host) {
                return Err("链接指向内网或保留地址，已拒绝".into());
            }
        }
        None => return Err("链接缺少主机名".into()),
    }
    Ok(())
}

fn resolve_public(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let port = if port == 0 { 80 } else { port };
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|_| "无法确认链接地址，已拒绝访问")?
        .collect();
    classify_addresses(&addrs.iter().map(|addr| addr.ip()).collect::<Vec<_>>())?;
    Ok(addrs)
}

pub(crate) fn classify_addresses(addrs: &[IpAddr]) -> Result<(), String> {
    if addrs.is_empty() {
        return Err("无法确认链接地址，已拒绝访问".into());
    }
    if addrs.iter().any(|ip| blocked_ip(*ip)) {
        return Err("链接指向内网或保留地址，已拒绝".into());
    }
    Ok(())
}

fn blocked_domain(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host == "localhost.localdomain"
        || host == "local"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".localdomain")
    {
        return true;
    }
    // Decimal or other non-dotted hosts are not public names we can trust.
    if host.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    host.parse::<Ipv4Addr>().is_ok() || host.parse::<Ipv6Addr>().is_ok()
}

pub(crate) fn blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => blocked_v4(ip),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return blocked_v4(v4);
            }
            blocked_v6(ip)
        }
    }
}

fn blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    match a {
        0 | 10 | 127 => true,
        100 if (64..128).contains(&b) => true,
        169 if b == 254 => true,
        172 if (16..32).contains(&b) => true,
        192 if b == 0 && (c == 0 || c == 2) => true,
        192 if b == 168 => true,
        198 if b == 18 || b == 19 => true,
        198 if b == 51 && c == 100 => true,
        203 if b == 0 && c == 113 => true,
        224..=255 => true,
        _ => false,
    }
}

fn blocked_v6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return true;
    }
    let first = ip.segments()[0];
    // fc00::/7 unique local, fe80::/10 link local, fec0::/10 site local.
    (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || (first & 0xffc0) == 0xfec0
        || (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
}

fn content_type_ok(header: Option<&str>) -> bool {
    let Some(header) = header else {
        return true;
    };
    let mime = header
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    mime.starts_with("text/")
        || matches!(
            mime.as_str(),
            "application/xhtml+xml" | "application/xml" | "text/xml"
        )
}

fn charset_ok(header: Option<&str>) -> bool {
    let Some(header) = header else {
        return true;
    };
    let lower = header.to_ascii_lowercase();
    if !lower.contains("charset=") {
        return true;
    }
    lower.contains("charset=utf-8")
        || lower.contains("charset=\"utf-8\"")
        || lower.contains("charset=us-ascii")
        || lower.contains("charset=\"us-ascii\"")
}

pub(crate) fn meta_charset_ok(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(4096)];
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();
    let Some(index) = text.find("charset=") else {
        return true;
    };
    let value: String = text[index + "charset=".len()..]
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    value.is_empty() || value == "utf-8" || value == "utf8" || value == "us-ascii"
}

pub(crate) fn extract_document(html: &str) -> (String, String) {
    let title = extract_title(html);
    let region = preferred_region(html);
    let text = collapse(&decode_entities(&visible_text(region)));
    (collapse(&decode_entities(&title)).replace('\n', " "), text)
}

fn extract_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else {
        return String::new();
    };
    let Some(open) = lower[start..].find('>') else {
        return String::new();
    };
    let from = start + open + 1;
    let Some(end) = lower[from..].find("</title") else {
        return String::new();
    };
    html[from..from + end].trim().to_string()
}

fn preferred_region(html: &str) -> &str {
    let lower = html.to_ascii_lowercase();
    for tag in ["article", "main"] {
        let needle = format!("<{tag}");
        let Some(start) = lower.find(&needle) else {
            continue;
        };
        // Require a tag boundary so "<mainstream" is not treated as <main.
        let boundary = lower.as_bytes().get(start + needle.len()).copied();
        if !matches!(boundary, Some(b'>' | b' ' | b'\n' | b'\t' | b'\r' | b'/')) {
            continue;
        }
        let close = format!("</{tag}");
        if let Some(rel) = lower[start..].find(&close) {
            return &html[start..start + rel];
        }
        return &html[start..];
    }
    html
}

fn visible_text(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    while !rest.is_empty() {
        if rest.starts_with("<!--") {
            rest = match rest.find("-->") {
                Some(index) => &rest[index + 3..],
                None => break,
            };
            continue;
        }
        if let Some(stripped) = rest.strip_prefix('<') {
            let (tag, next) = match stripped.find('>') {
                Some(index) => (&stripped[..index], &stripped[index + 1..]),
                None => break,
            };
            let (closing, name) = tag_parts(tag);
            if !closing
                && matches!(
                    name.as_str(),
                    "script" | "style" | "noscript" | "svg" | "template" | "head"
                )
            {
                let close = format!("</{name}");
                let lower = next.to_ascii_lowercase();
                rest = match lower.find(&close) {
                    Some(index) => {
                        let after = &next[index + close.len()..];
                        match after.find('>') {
                            Some(end) => &after[end + 1..],
                            None => "",
                        }
                    }
                    None => break,
                };
                continue;
            }
            if is_block(&name) {
                out.push('\n');
            }
            rest = next;
            continue;
        }
        let end = rest.find('<').unwrap_or(rest.len());
        out.push_str(&rest[..end]);
        rest = &rest[end..];
    }
    out
}

fn tag_parts(tag: &str) -> (bool, String) {
    let tag = tag.trim();
    let closing = tag.starts_with('/');
    let source = tag.trim_start_matches('/').trim_start();
    let mut name = String::new();
    for ch in source.chars() {
        if ch.is_ascii_alphanumeric() {
            name.push(ch.to_ascii_lowercase());
        } else {
            break;
        }
    }
    (closing, name)
}

fn is_block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "br"
            | "li"
            | "tr"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "blockquote"
            | "ul"
            | "ol"
            | "table"
            | "pre"
            | "hr"
    )
}

pub(crate) fn decode_entities(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest.find(';') else {
            out.push_str(rest);
            return out;
        };
        if end == 0 || end > 16 {
            out.push('&');
            rest = &rest[1..];
            continue;
        }
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ if entity.starts_with('#') => decode_numeric(&entity[1..]),
            _ => None,
        };
        if let Some(ch) = decoded {
            if ch == '\n' || ch == '\t' || !ch.is_control() {
                out.push(ch);
            }
            rest = &rest[end + 1..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

fn decode_numeric(body: &str) -> Option<char> {
    let (digits, radix) = if let Some(hex) = body.strip_prefix(['x', 'X']) {
        (hex, 16)
    } else {
        (body, 10)
    };
    if digits.is_empty() {
        return None;
    }
    let code = u32::from_str_radix(digits, radix).ok()?;
    char::from_u32(code)
}

fn collapse(input: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in input.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank += 1;
            if blank == 1 && !out.is_empty() {
                out.push('\n');
            }
            continue;
        }
        blank = 0;
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&line);
    }
    out.trim().to_string()
}

pub(crate) fn truncate_chars(input: &str, max: usize) -> (String, bool) {
    if input.chars().count() <= max {
        (input.to_string(), false)
    } else {
        (input.chars().take(max).collect(), true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_non_http_urls_are_rejected() {
        for url in [
            "http://127.0.0.1/",
            "http://127.0.0.1:9/secret",
            "http://localhost/",
            "http://localhost:8080/x",
            "http://LocalHost/x",
            "http://10.1.2.3/",
            "http://192.168.1.1/a",
            "http://172.16.5.5/",
            "http://172.31.255.255/",
            "http://169.254.169.254/latest",
            "http://0.0.0.0/",
            "http://100.64.0.1/",
            "http://192.0.2.1/",
            "http://198.18.0.1/",
            "http://203.0.113.5/",
            "http://224.0.0.1/",
            "http://255.255.255.255/",
            "http://[::1]/",
            "http://[::]/",
            "http://[fd00::1]/",
            "http://[fc00::1]/",
            "http://[fe80::1]/",
            "http://[fec0::1]/",
            "http://[ff02::1]/",
            "http://[2001:db8::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:10.0.0.1]/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://user:secret@example.com/",
            "http://user@example.com/a",
            "http://printer.local/",
            "http://foo.localhost/",
            "http://metadata.google.internal/",
            "http://2130706433/",
            "data:text/html,hi",
        ] {
            assert!(check_url(url).is_err(), "{url} should be rejected");
        }
        assert!(check_url("https://example.com/docs").is_ok());
        assert!(check_url("http://172.15.0.1/").is_ok());
        assert!(check_url("http://8.8.8.8/").is_ok());
        assert!(check_url("http://[2001:4860:4860::8888]/").is_ok());
        assert!(!blocked_ip("1.1.1.1".parse().unwrap()));
        assert!(blocked_ip("192.168.0.1".parse().unwrap()));
    }

    #[test]
    fn redirects_are_checked_again() {
        let current = check_url("https://example.com/a").unwrap();
        assert!(check_redirect(&current, "http://127.0.0.1/secret").is_err());
        assert!(check_redirect(&current, "http://10.0.0.8/x").is_err());
        assert!(check_redirect(&current, "file:///etc/passwd").is_err());
        assert!(check_redirect(&current, "//192.168.0.9/x").is_err());
        assert!(check_redirect(&current, "//localhost/admin").is_err());
        let next = check_redirect(&current, "https://example.com/b").unwrap();
        assert_eq!(next.as_str(), "https://example.com/b");
        assert!(check_redirect(&current, "/relative").is_ok());
    }

    #[test]
    fn mixed_dns_answers_are_rejected() {
        let private = "10.0.0.1".parse().unwrap();
        let public = "1.2.3.4".parse().unwrap();
        assert!(classify_addresses(&[public, private]).is_err());
        assert!(classify_addresses(&[]).is_err());
        assert!(classify_addresses(&[public]).is_ok());
    }

    #[test]
    fn html_text_is_extracted_and_truncated() {
        let html = "<html><head><title>标题</title><style>body{color:red}</style></head><body><script>alert(1)</script><article><p>第一段</p><p>第二段 &amp; 符号</p></article></body></html>";
        let (title, text) = extract_document(html);
        assert_eq!(title, "标题");
        assert!(text.contains("第一段"), "{text}");
        assert!(text.contains("第二段 & 符号"), "{text}");
        assert!(!text.contains("alert"));
        assert!(!text.contains("color"));
        let (short, cut) = truncate_chars(&"字".repeat(MAX_CHARS + 5), MAX_CHARS);
        assert!(cut);
        assert_eq!(short.chars().count(), MAX_CHARS);
        assert!(!meta_charset_ok(b"<meta charset=\"gbk\">"));
        assert!(meta_charset_ok(b"<meta charset=\"utf-8\">"));
    }

    #[tokio::test]
    async fn command_rejects_private_urls_without_connecting() {
        for url in [
            "http://127.0.0.1/",
            "http://192.168.1.20/a",
            "http://10.0.0.2/",
            "file:///etc/passwd",
            "http://localhost/admin",
        ] {
            let err = read_page(url.into()).await.unwrap_err();
            assert!(
                err.contains("拒绝") || err.contains("只接受") || err.contains("内网"),
                "{url}: {err}"
            );
        }
    }
}
