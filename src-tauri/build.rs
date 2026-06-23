use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
};

const SPACE_BUILD_ENV_KEYS: &[&str] = &[
    "MYAGENTS_SPACE_ENABLED",
    "MYAGENTS_SPACE_BASE_URL",
    "MYAGENTS_SPACE_PUBLIC_CLIENT_ID",
    "MYAGENTS_SPACE_CLIENT_ID",
];

fn main() {
    expose_space_build_env();
    tauri_build::build()
}

fn expose_space_build_env() {
    for key in SPACE_BUILD_ENV_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let root_env_path = env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .and_then(|manifest_dir| manifest_dir.parent().map(|root| root.join(".env")));

    let file_env = root_env_path
        .as_ref()
        .map(|path| {
            println!("cargo:rerun-if-changed={}", path.display());
            read_space_env_file(path)
        })
        .unwrap_or_default();

    let mut resolved_env = SPACE_BUILD_ENV_KEYS
        .iter()
        .filter_map(|key| {
            env::var(key)
                .ok()
                .or_else(|| file_env.get(*key).cloned())
                .map(|value| ((*key).to_string(), value))
        })
        .collect::<HashMap<_, _>>();

    normalize_space_build_env(&mut resolved_env);

    for key in SPACE_BUILD_ENV_KEYS {
        if let Some(value) = resolved_env.get(*key) {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}

fn read_space_env_file(path: &Path) -> HashMap<String, String> {
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };

    content
        .lines()
        .filter_map(parse_space_env_line)
        .collect::<HashMap<_, _>>()
}

fn parse_space_env_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let trimmed = trimmed
        .strip_prefix("export ")
        .unwrap_or(trimmed)
        .trim_start();
    let (key, value) = trimmed.split_once('=')?;
    let key = key.trim();
    if !SPACE_BUILD_ENV_KEYS.contains(&key) {
        return None;
    }

    Some((key.to_string(), parse_env_value(value)))
}

fn parse_env_value(value: &str) -> String {
    let value = strip_unquoted_comment(value.trim()).trim();
    if let Some(unquoted) = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
    {
        return unquoted.to_string();
    }
    if let Some(unquoted) = value
        .strip_prefix('\'')
        .and_then(|inner| inner.strip_suffix('\''))
    {
        return unquoted.to_string();
    }

    value.to_string()
}

fn strip_unquoted_comment(value: &str) -> &str {
    let mut quote: Option<char> = None;
    for (index, ch) in value.char_indices() {
        match ch {
            '"' | '\'' if quote == Some(ch) => quote = None,
            '"' | '\'' if quote.is_none() => quote = Some(ch),
            '#' if quote.is_none() => return value[..index].trim_end(),
            _ => {}
        }
    }
    value
}

fn normalize_space_build_env(values: &mut HashMap<String, String>) {
    let enabled = values
        .get("MYAGENTS_SPACE_ENABLED")
        .map(String::as_str)
        .map(space_enabled_flag)
        .unwrap_or(false);
    if !enabled {
        return;
    }

    let base_url = values
        .get("MYAGENTS_SPACE_BASE_URL")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    match normalize_space_base_url(base_url) {
        Ok(normalized) => {
            values.insert("MYAGENTS_SPACE_BASE_URL".to_string(), normalized);
        }
        Err(error) => panic!("Invalid Space build configuration: {error}"),
    }
}

fn space_enabled_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn normalize_space_base_url(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err(
            "MYAGENTS_SPACE_BASE_URL is required when MYAGENTS_SPACE_ENABLED=true".to_string(),
        );
    }
    let mut url = url::Url::parse(raw)
        .map_err(|error| format!("Invalid MYAGENTS_SPACE_BASE_URL: {error}"))?;
    if url.scheme() != "https" {
        return Err("MYAGENTS_SPACE_BASE_URL must use https".to_string());
    }
    if url.host_str().is_none() {
        return Err("MYAGENTS_SPACE_BASE_URL must include a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("MYAGENTS_SPACE_BASE_URL must not include credentials".to_string());
    }
    if url.path() != "/" {
        return Err("MYAGENTS_SPACE_BASE_URL must not include a path".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}
