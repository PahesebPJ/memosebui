use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThemeMode {
    Light,
    Dark,
}

impl ThemeMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryNodeSummary {
    pub id: String,
    pub project_id: String,
    pub category: String,
    pub title: String,
    pub importance: f32,
}

pub fn cosine_similarity_f32(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len().min(b.len());
    if len == 0 {
        return 0.0;
    }
    let mut dot = 0.0_f32;
    let mut norm_a = 0.0_f32;
    let mut norm_b = 0.0_f32;
    for i in 0..len {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b).sqrt()
}

pub struct MindIpcRouter {
    pub theme: Mutex<ThemeMode>,
    pub active_project: Mutex<String>,
    pub min_similarity: Mutex<f32>,
}

impl Default for MindIpcRouter {
    fn default() -> Self {
        Self::new()
    }
}

impl MindIpcRouter {
    pub fn new() -> Self {
        Self {
            theme: Mutex::new(ThemeMode::Dark),
            active_project: Mutex::new("all".to_string()),
            min_similarity: Mutex::new(0.38),
        }
    }

    pub fn dispatch(&self, command: &str, payload: &str) -> Result<String, String> {
        match command {
            "mind:get_theme" => {
                let th = self.theme.lock().unwrap();
                Ok(format!(r#"{{"theme":"{}"}}"#, th.as_str()))
            }
            "mind:set_theme" => {
                let mut th = self.theme.lock().unwrap();
                if payload.contains("light") {
                    *th = ThemeMode::Light;
                } else {
                    *th = ThemeMode::Dark;
                }
                Ok(format!(r#"{{"theme":"{}"}}"#, th.as_str()))
            }
            "mind:set_project_filter" => {
                let mut proj = self.active_project.lock().unwrap();
                let next = payload.trim();
                *proj = if next.is_empty() {
                    "all".to_string()
                } else {
                    next.to_string()
                };
                Ok(format!(r#"{{"project":"{}"}}"#, *proj))
            }
            "mind:get_state" => {
                let th = self.theme.lock().unwrap();
                let proj = self.active_project.lock().unwrap();
                let sim = self.min_similarity.lock().unwrap();
                Ok(format!(
                    r#"{{"theme":"{}","project":"{}","minSimilarity":{:.2}}}"#,
                    th.as_str(),
                    *proj,
                    *sim
                ))
            }
            _ => Err(format!("Unknown IPC command: {command}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity() {
        let a = [1.0_f32, 0.0, 1.0];
        let b = [1.0_f32, 0.0, 1.0];
        let c = [0.0_f32, 1.0, 0.0];
        assert!((cosine_similarity_f32(&a, &b) - 1.0).abs() < 1e-5);
        assert!((cosine_similarity_f32(&a, &c) - 0.0).abs() < 1e-5);
    }

    #[test]
    fn test_ipc_router_commands() {
        let router = MindIpcRouter::new();
        assert_eq!(
            router.dispatch("mind:get_theme", "").unwrap(),
            r#"{"theme":"dark"}"#
        );
        assert_eq!(
            router.dispatch("mind:set_theme", "light").unwrap(),
            r#"{"theme":"light"}"#
        );
        assert_eq!(
            router
                .dispatch("mind:set_project_filter", "memoseb")
                .unwrap(),
            r#"{"project":"memoseb"}"#
        );
        let state = router.dispatch("mind:get_state", "").unwrap();
        assert!(state.contains(r#""project":"memoseb""#));
    }
}
