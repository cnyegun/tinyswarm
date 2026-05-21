use serde_json::Value;

#[derive(Debug, Clone)]
pub struct SwarmEvent {
    value: Value,
}

impl SwarmEvent {
    pub fn parse(line: &str) -> Option<Self> {
        let value = serde_json::from_str::<Value>(line).ok()?;
        value.get("type")?.as_str()?;
        Some(Self { value })
    }

    pub fn kind(&self) -> Option<&str> {
        self.str("type")
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.value.get(key)?.as_str()
    }

    pub fn u64(&self, key: &str) -> Option<u64> {
        self.value.get(key)?.as_u64()
    }

    pub fn bool(&self, key: &str) -> Option<bool> {
        self.value.get(key)?.as_bool()
    }

    pub fn array(&self, key: &str) -> Option<&Vec<Value>> {
        self.value.get(key)?.as_array()
    }

    pub fn clock(&self) -> String {
        self.str("timestamp")
            .and_then(|timestamp| timestamp.split('T').nth(1))
            .map(|time| time.chars().take(8).collect())
            .unwrap_or_else(|| "--:--:--".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::SwarmEvent;

    #[test]
    fn parses_basic_event() {
        let event = SwarmEvent::parse(r#"{"type":"check","passed":true,"failures":0}"#).unwrap();
        assert_eq!(event.kind(), Some("check"));
        assert_eq!(event.bool("passed"), Some(true));
        assert_eq!(event.u64("failures"), Some(0));
    }
}
