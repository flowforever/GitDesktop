/// Fork release builds opt into their own stores and credential namespace.
pub(crate) const FORK_STABLE_IDENTIFIER: &str = "io.github.flowforever.gitdesktop";
pub(crate) const APP_IDENTIFIER: &str = if option_env!("GITDESKTOP_FORK_STABLE").is_some() {
    FORK_STABLE_IDENTIFIER
} else {
    "com.thebguy.gitdesktop"
};
