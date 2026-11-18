//! GitLab's account-scoped home categories and native to-do list.

use std::collections::HashSet;
use std::future::Future;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::my_work::{
    merge_legs, normalize_updated_at, MyWorkItem, MyWorkLeg, MyWorkPage, MY_WORK_LIMIT,
};
use super::{encode_query_value, futures_join_all, gitlab, glab};
use crate::error::{AppError, AppResult};

const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 5;
const CONCURRENCY: usize = 4;
const MAX_WATCHED_MRS: usize = 100;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkSection {
    Mine,
    Authored,
    Team,
    Mentioned,
    Issues,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MrListStatus {
    #[default]
    Open,
    Merged,
}

impl MrListStatus {
    fn gitlab_state(self) -> &'static str {
        match self {
            Self::Open => "opened",
            Self::Merged => "merged",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchedMrState {
    Opened,
    Merged,
    Closed,
}

impl WatchedMrState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Opened => "opened",
            Self::Merged => "merged",
            Self::Closed => "closed",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct WatchedMergeRequest {
    pub item: MyWorkItem,
    pub state: WatchedMrState,
}

#[derive(Debug)]
struct WatchTarget {
    host: String,
    project: String,
    iid: u64,
}

impl WatchTarget {
    fn endpoint(&self) -> String {
        format!(
            "projects/{}/merge_requests/{}?with_labels_details=true",
            encode_query_value(&self.project),
            self.iid
        )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTodo {
    pub id: String,
    pub host: String,
    pub title: String,
    pub action: String,
    pub target_type: String,
    pub url: String,
    pub updated_at: String,
    pub item: Option<MyWorkItem>,
}

#[derive(Debug, Serialize)]
pub struct TodoPage {
    pub items: Vec<WorkTodo>,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct WorkAccount {
    pub host: String,
    pub login: Option<String>,
}

#[tauri::command]
pub async fn gitlab_work_accounts() -> Vec<WorkAccount> {
    let hosts = gitlab_work_hosts().await;
    let mut accounts = Vec::new();
    for batch in hosts.chunks(CONCURRENCY) {
        accounts.extend(
            futures_join_all(batch.iter().map(|host| async move {
                let login = read_json(host, "user").await.ok().and_then(|user| {
                    user.get("username")
                        .and_then(Value::as_str)
                        .filter(|login| !login.trim().is_empty())
                        .map(str::to_string)
                });
                WorkAccount {
                    host: host.clone(),
                    login,
                }
            }))
            .await,
        );
    }
    accounts
}

fn unreadable(message: &str) -> AppError {
    AppError::Glab(message.into())
}

fn watch_target(url: &str, hosts: &[String]) -> AppResult<WatchTarget> {
    let invalid = || AppError::InvalidArgument("Enter a GitLab merge request URL.".into());
    let url = url.trim();
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) || url.contains('\\') {
        return Err(invalid());
    }
    let parsed = tauri::Url::parse(url).map_err(|_| invalid())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return Err(invalid());
    }
    let host = parsed
        .host_str()
        .filter(|host| glab::is_addressable_host(host))
        .ok_or_else(invalid)?;
    let host = hosts
        .iter()
        .find(|configured| configured.eq_ignore_ascii_case(host))
        .ok_or_else(|| AppError::InvalidArgument("This GitLab host is not configured.".into()))?
        .clone();
    let path = parsed.path().strip_prefix('/').ok_or_else(invalid)?;
    let (project, iid) = path.split_once("/-/merge_requests/").ok_or_else(invalid)?;
    let (owner, repo) = project.rsplit_once('/').ok_or_else(invalid)?;
    super::validate_owner(owner).map_err(|_| invalid())?;
    super::validate_repo_name(repo).map_err(|_| invalid())?;
    let iid = iid.strip_suffix('/').unwrap_or(iid);
    if !iid.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let iid = iid
        .parse::<u64>()
        .ok()
        .filter(|iid| *iid > 0)
        .ok_or_else(invalid)?;
    Ok(WatchTarget {
        host,
        project: project.to_string(),
        iid,
    })
}

fn watched_mr_from_value(raw: &Value, target: &WatchTarget) -> AppResult<WatchedMergeRequest> {
    let invalid = || unreadable("GitLab returned an unreadable watched merge request.");
    let item = gitlab::my_work_item_from_value(raw, true).ok_or_else(invalid)?;
    let actual = watch_target(&item.url, std::slice::from_ref(&target.host)).map_err(|_| invalid())?;
    if item.number != target.iid || actual.iid != target.iid || actual.project != target.project {
        return Err(invalid());
    }
    let state = match raw.get("state").and_then(Value::as_str) {
        Some("opened") => WatchedMrState::Opened,
        Some("merged") => WatchedMrState::Merged,
        Some("closed") => WatchedMrState::Closed,
        _ => return Err(invalid()),
    };
    Ok(WatchedMergeRequest { item, state })
}

fn validate_watch_count(urls: &[String]) -> AppResult<()> {
    if urls.len() > MAX_WATCHED_MRS {
        return Err(AppError::InvalidArgument(format!(
            "Watch up to {MAX_WATCHED_MRS} merge requests."
        )));
    }
    Ok(())
}

fn work_stamp(raw: &Value) -> String {
    let value = ["updated_at", "created_at"]
        .iter()
        .find_map(|key| {
            raw.get(key)
                .and_then(Value::as_str)
                .filter(|stamp| chrono::DateTime::parse_from_rfc3339(stamp).is_ok())
        })
        .unwrap_or_default();
    normalize_updated_at(value)
}

fn mention_targets(mut rows: Vec<Value>, limit: usize) -> (Vec<(u64, u64)>, bool) {
    rows.sort_by_cached_key(|row| std::cmp::Reverse(work_stamp(row)));
    let mut seen = HashSet::new();
    let mut targets = Vec::new();
    for row in rows {
        if let (Some(project), Some(iid)) = (
            row.pointer("/project/id").and_then(Value::as_u64),
            row.pointer("/target/iid").and_then(Value::as_u64),
        ) {
            if project > 0 && iid > 0 && seen.insert((project, iid)) {
                targets.push((project, iid));
            }
        }
    }
    let capped = targets.len() > limit;
    targets.truncate(limit);
    (targets, capped)
}

fn scope_endpoints(
    section: WorkSection,
    labels: &[String],
    viewer: &str,
    status: MrListStatus,
) -> AppResult<Vec<String>> {
    let state = if section == WorkSection::Issues {
        "opened"
    } else {
        status.gitlab_state()
    };
    let base =
        format!("state={state}&order_by=updated_at&sort=desc&per_page=100&with_labels_details=true");
    let viewer = encode_query_value(viewer);
    Ok(match section {
        WorkSection::Mine => vec![
            format!("merge_requests?{base}&scope=assigned_to_me"),
            format!("merge_requests?{base}&scope=all&reviewer_username={viewer}"),
            format!("merge_requests?{base}&scope=created_by_me"),
        ],
        WorkSection::Authored => vec![format!("merge_requests?{base}&scope=created_by_me")],
        WorkSection::Issues => vec![
            format!("issues?{base}&scope=created_by_me"),
            format!("issues?{base}&scope=assigned_to_me"),
        ],
        WorkSection::Team => {
            if labels.len() > 6 {
                return Err(AppError::InvalidArgument(
                    "Choose up to six team labels.".into(),
                ));
            }
            let mut seen = HashSet::new();
            let mut scopes = Vec::new();
            for label in labels {
                if label.trim().is_empty()
                    || label.contains(',')
                    || ["none", "any"]
                        .iter()
                        .any(|v| label.eq_ignore_ascii_case(v))
                {
                    return Err(AppError::InvalidArgument("Team labels must be nonempty literal label names; commas and GitLab's Any/None filters are not supported.".into()));
                }
                if seen.insert(label) {
                    scopes.push(format!(
                        "merge_requests?{base}&scope=all&labels={}",
                        encode_query_value(label)
                    ));
                }
            }
            scopes
        }
        WorkSection::Mentioned => ["mentioned", "directly_addressed"]
            .iter()
            .flat_map(|action| {
                ["pending", "done"].iter().map(move |state| {
                    format!("todos?type=MergeRequest&per_page=100&action={action}&state={state}")
                })
            })
            .collect(),
    })
}

fn mention_is_other_work(raw: &Value, viewer: &str, status: MrListStatus) -> AppResult<bool> {
    if raw.get("state").and_then(Value::as_str) != Some(status.gitlab_state()) {
        return Ok(false);
    }
    for role in ["assignees", "reviewers"] {
        let people = raw.get(role).and_then(Value::as_array).ok_or_else(|| {
            unreadable("GitLab did not report the MR's current assignees and reviewers.")
        })?;
        for person in people {
            let username = person
                .get("username")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| unreadable("GitLab returned an unreadable MR participant."))?;
            if username.eq_ignore_ascii_case(viewer) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn parse_todo(raw: &Value, host: &str) -> Option<WorkTodo> {
    let id = raw
        .get("id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)?
        .to_string();
    let url = raw.get("target_url").and_then(Value::as_str)?;
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || !super::remote_host(url)?.eq_ignore_ascii_case(host)
    {
        return None;
    }
    let target_type = raw.get("target_type").and_then(Value::as_str)?.to_string();
    let title = raw
        .pointer("/target/title")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .or_else(|| {
            raw.get("body")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
        })
        .unwrap_or(&target_type)
        .to_string();
    let item = if ["MergeRequest", "Issue"].contains(&target_type.as_str()) {
        raw.get("target").cloned().and_then(|mut target| {
            target.as_object_mut()?.insert(
                "web_url".into(),
                Value::String(url.split('#').next()?.to_string()),
            );
            gitlab::my_work_item_from_value(&target, target_type == "MergeRequest")
        })
    } else {
        None
    };
    Some(WorkTodo {
        id,
        host: host.to_string(),
        title,
        action: raw
            .get("action_name")
            .and_then(Value::as_str)
            .unwrap_or("pending")
            .to_string(),
        target_type,
        url: url.to_string(),
        updated_at: work_stamp(raw),
        item,
    })
}

async fn read_json(host: &str, endpoint: &str) -> AppResult<Value> {
    let out = glab::run_glab_api_for_host(host, &[endpoint], glab::GLAB_NETWORK_TIMEOUT).await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|_| unreadable("GitLab returned unreadable work items."))
}

async fn watched_items_with<F, Fut>(
    urls: &[String],
    hosts: &[String],
    status: MrListStatus,
    fetch: F,
) -> AppResult<MyWorkPage>
where
    F: Fn(String, String) -> Fut,
    Fut: Future<Output = AppResult<Value>>,
{
    validate_watch_count(urls)?;
    if urls.is_empty() {
        return Ok(MyWorkPage::empty());
    }
    let mut seen = HashSet::new();
    let mut targets = Vec::new();
    let mut failure = None;
    for url in urls {
        match watch_target(url, hosts) {
            Ok(target) => {
                if seen.insert((
                    target.host.to_ascii_lowercase(),
                    target.project.clone(),
                    target.iid,
                )) {
                    targets.push(target);
                }
            }
            Err(error) => failure = Some(error),
        }
    }
    let mut items = Vec::new();
    let mut answered = false;
    for batch in targets.chunks(CONCURRENCY) {
        let outcomes = futures_join_all(batch.iter().map(|target| {
            let fetch = &fetch;
            async move {
                let raw = fetch(target.host.clone(), target.endpoint()).await?;
                watched_mr_from_value(&raw, target)
            }
        }))
        .await;
        for outcome in outcomes {
            match outcome {
                Ok(watched) => {
                    answered = true;
                    if watched.state.as_str() == status.gitlab_state() {
                        items.push(watched.item);
                    }
                }
                Err(error) => failure = Some(error),
            }
        }
    }
    if !answered {
        return Err(
            failure.unwrap_or_else(|| unreadable("Watched merge requests could not be loaded."))
        );
    }
    Ok(merge_legs(
        vec![MyWorkLeg {
            items,
            capped: failure.is_some(),
        }],
        MY_WORK_LIMIT,
    ))
}

async fn walk(host: &str, endpoint: &str) -> AppResult<(Vec<Value>, bool)> {
    walk_with(endpoint, |path| async move { read_json(host, &path).await }).await
}

async fn walk_with<F, Fut>(endpoint: &str, mut fetch: F) -> AppResult<(Vec<Value>, bool)>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = AppResult<Value>>,
{
    let mut rows = Vec::new();
    for page in 1..=MAX_PAGES {
        let value = fetch(format!("{endpoint}&page={page}")).await?;
        let values = value
            .as_array()
            .ok_or_else(|| unreadable("GitLab returned an unreadable work list."))?;
        let more = values.len() >= PAGE_SIZE;
        rows.extend(values.iter().cloned());
        if !more {
            return Ok((rows, false));
        }
    }
    Ok((rows, true))
}

async fn host_items(
    host: &str,
    section: WorkSection,
    labels: &[String],
    status: MrListStatus,
) -> AppResult<MyWorkPage> {
    let user = read_json(host, "user").await?;
    let viewer = user
        .get("username")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| unreadable("GitLab did not report your username."))?;
    let scopes = scope_endpoints(section, labels, viewer, status)?;
    let mut raw = Vec::new();
    let mut capped = false;
    for batch in scopes.chunks(CONCURRENCY) {
        for outcome in futures_join_all(batch.iter().map(|s| walk(host, s))).await {
            let (rows, cut) = outcome?;
            raw.extend(rows);
            capped |= cut;
        }
    }
    let mut items = Vec::new();
    if section == WorkSection::Mentioned {
        // A Todo target may omit reviewers; current MR details establish the exclusion.
        let (targets, cut) = mention_targets(raw, MY_WORK_LIMIT);
        capped |= cut;
        for batch in targets.chunks(CONCURRENCY) {
            let outcomes = futures_join_all(batch.iter().map(|(project, iid)| async move {
                let raw = read_json(
                    host,
                    &format!("projects/{project}/merge_requests/{iid}?with_labels_details=true"),
                )
                .await?;
                Ok::<_, AppError>(if mention_is_other_work(&raw, viewer, status)? {
                    gitlab::my_work_item_from_value(&raw, true)
                } else {
                    None
                })
            }))
            .await;
            for outcome in outcomes {
                match outcome {
                    Ok(Some(item)) => items.push(item),
                    Ok(None) => {}
                    Err(_) => capped = true,
                }
            }
        }
    } else {
        items.extend(raw.iter().filter_map(|row| {
            gitlab::my_work_item_from_value(row, section != WorkSection::Issues)
        }));
    }
    Ok(merge_legs(vec![MyWorkLeg { items, capped }], MY_WORK_LIMIT))
}

#[tauri::command]
pub async fn gitlab_work_hosts() -> Vec<String> {
    glab::account_hosts()
        .await
        .into_iter()
        .filter(|host| glab::is_addressable_host(host))
        .collect()
}

#[tauri::command]
pub async fn gitlab_work_items(
    section: WorkSection,
    labels: Vec<String>,
    status: Option<MrListStatus>,
    watched_urls: Option<Vec<String>>,
) -> AppResult<MyWorkPage> {
    let status = status.unwrap_or_default();
    let watched_urls = watched_urls.unwrap_or_default();
    validate_watch_count(&watched_urls)?;
    // Validate before touching the network, including the unconfigured team state.
    scope_endpoints(section, &labels, "viewer", status)?;
    if section == WorkSection::Team && labels.is_empty() {
        return Ok(MyWorkPage::empty());
    }
    let hosts = gitlab_work_hosts().await;
    if hosts.is_empty() {
        return Ok(MyWorkPage {
            items: Vec::new(),
            truncated: section == WorkSection::Mine && !watched_urls.is_empty(),
        });
    }
    let mut results =
        futures_join_all(hosts.iter().map(|host| host_items(host, section, &labels, status))).await;
    if section == WorkSection::Mine && !watched_urls.is_empty() {
        results.push(
            watched_items_with(&watched_urls, &hosts, status, |host, endpoint| async move {
                read_json(&host, &endpoint).await
            })
            .await,
        );
    }
    fold_results(results)
}

#[tauri::command]
pub async fn gitlab_work_watch_mr(url: String) -> AppResult<WatchedMergeRequest> {
    let hosts = gitlab_work_hosts().await;
    let target = watch_target(&url, &hosts)?;
    let raw = read_json(&target.host, &target.endpoint()).await?;
    watched_mr_from_value(&raw, &target)
}

fn fold_results(results: Vec<AppResult<MyWorkPage>>) -> AppResult<MyWorkPage> {
    let mut legs = Vec::new();
    let mut failure = None;
    let mut seen = HashSet::new();
    for result in results {
        match result {
            Ok(mut page) => {
                page.items.retain(|item| {
                    seen.insert((
                        item.host.to_ascii_lowercase(),
                        item.repo_full_name.clone(),
                        item.number,
                        item.is_pull_request,
                    ))
                });
                legs.push(MyWorkLeg {
                    items: page.items,
                    capped: page.truncated,
                });
            }
            Err(error) => failure = Some(error),
        }
    }
    if legs.is_empty() {
        return Err(failure.unwrap_or_else(|| unreadable("GitLab work could not be loaded.")));
    }
    let mut page = merge_legs(legs, MY_WORK_LIMIT);
    page.truncated |= failure.is_some();
    Ok(page)
}

#[tauri::command]
pub async fn gitlab_work_todos() -> AppResult<TodoPage> {
    let hosts = gitlab_work_hosts().await;
    let mut items = Vec::new();
    let mut truncated = false;
    let mut answered = hosts.is_empty();
    let mut failure = None;
    let results = futures_join_all(hosts.iter().map(|host| async move {
        let (rows, capped) = walk(host, "todos?state=pending&per_page=100").await?;
        Ok::<_, AppError>((
            rows.into_iter()
                .filter_map(|row| parse_todo(&row, host))
                .collect::<Vec<_>>(),
            capped,
        ))
    }))
    .await;
    for result in results {
        match result {
            Ok((todos, capped)) => {
                answered = true;
                items.extend(todos);
                truncated |= capped;
            }
            Err(error) => failure = Some(error),
        }
    }
    if !answered {
        return Err(failure.unwrap_or_else(|| unreadable("GitLab to-dos could not be loaded.")));
    }
    let mut seen = HashSet::new();
    items.retain(|todo| seen.insert((todo.host.clone(), todo.id.clone())));
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    truncated |= failure.is_some() || items.len() > MY_WORK_LIMIT;
    items.truncate(MY_WORK_LIMIT);
    Ok(TodoPage { items, truncated })
}

#[tauri::command]
pub async fn gitlab_work_todo_done(host: String, id: String) -> AppResult<()> {
    let id = id
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| AppError::InvalidArgument("Invalid GitLab to-do id.".into()))?;
    let hosts = gitlab_work_hosts().await;
    let host = hosts
        .iter()
        .find(|configured| configured.eq_ignore_ascii_case(&host))
        .ok_or_else(|| AppError::InvalidArgument("This GitLab host is not configured.".into()))?;
    let path = format!("todos/{id}/mark_as_done");
    let out = glab::run_glab_api_for_host(
        host,
        &[&path, "--method", "POST"],
        glab::GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let value: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|_| unreadable("GitLab did not confirm completion. Refresh your to-dos."))?;
    if value.get("id").and_then(Value::as_u64) != Some(id)
        || value.get("state").and_then(Value::as_str) != Some("done")
    {
        return Err(unreadable(
            "GitLab did not confirm completion. Refresh your to-dos.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[tokio::test]
    async fn pagination_stops_on_a_short_page_and_marks_the_five_page_horizon() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = AtomicUsize::new(0);
        let (rows, capped) = walk_with("todos?per_page=100", |path| {
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            assert!(path.ends_with(&format!("page={n}")));
            async move {
                Ok(Value::Array(if n == 1 {
                    vec![json!({}); 100]
                } else {
                    vec![]
                }))
            }
        })
        .await
        .unwrap();
        assert_eq!(
            (calls.load(Ordering::SeqCst), rows.len(), capped),
            (2, 100, false)
        );
        let (rows, capped) = walk_with("todos?per_page=100", |_| async {
            Ok(Value::Array(vec![json!({}); 100]))
        })
        .await
        .unwrap();
        assert_eq!((rows.len(), capped), (500, true));
        assert!(walk_with("todos?per_page=100", |_| async {
            Ok(json!({"error":"bad response"}))
        })
        .await
        .is_err());
    }

    #[test]
    fn partial_hosts_keep_items_and_all_failed_hosts_return_an_error() {
        let item = gitlab::my_work_item_from_value(&mr(), true).unwrap();
        let good = merge_legs(
            vec![MyWorkLeg {
                items: vec![item],
                capped: false,
            }],
            MY_WORK_LIMIT,
        );
        let page = fold_results(vec![Ok(good), Err(unreadable("offline"))]).unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.truncated);
        assert!(fold_results(vec![Err(unreadable("offline"))]).is_err());
    }

    #[test]
    fn bounded_mention_hydration_prioritizes_recent_records_after_deduplication() {
        let records = vec![
            json!({"project":{"id":1},"target":{"iid":1},"updated_at":"2025-01-01T00:00:00Z"}),
            json!({"project":{"id":2},"target":{"iid":9},"updated_at":"2026-11-17T00:00:00Z"}),
            json!({"project":{"id":2},"target":{"iid":9},"updated_at":"2026-11-16T00:00:00Z"}),
        ];
        let (targets, capped) = mention_targets(records, 1);
        assert_eq!(targets, vec![(2, 9)]);
        assert!(capped);
    }

    fn mr() -> Value {
        json!({"iid":7,"title":"Review me","web_url":"https://git.example.com/a/sub/repo/-/merge_requests/7","state":"opened","assignees":[],"reviewers":[],"updated_at":"2026-11-17T01:00:00Z"})
    }

    #[test]
    fn personal_mrs_include_assigned_reviewed_and_authored() {
        let scopes = scope_endpoints(WorkSection::Mine, &[], "me", MrListStatus::Open).unwrap();
        assert_eq!(scopes.len(), 3);
        assert!(scopes[0].contains("scope=assigned_to_me"));
        assert!(scopes[1].contains("scope=all&reviewer_username=me"));
        assert!(scopes[2].contains("scope=created_by_me"));
    }

    #[test]
    fn mr_and_issue_scopes_request_label_details_and_todo_scopes_keep_their_query() {
        for section in [
            WorkSection::Mine,
            WorkSection::Authored,
            WorkSection::Team,
            WorkSection::Issues,
        ] {
            let scopes =
                scope_endpoints(section, &["team".into()], "me", MrListStatus::Open).unwrap();
            assert!(!scopes.is_empty());
            for scope in scopes {
                let (_, query) = scope.split_once('?').unwrap();
                assert_eq!(
                    query
                        .split('&')
                        .filter(|part| *part == "with_labels_details=true")
                        .count(),
                    1,
                    "{scope} must request detailed labels exactly once"
                );
            }
        }
        let scopes = scope_endpoints(WorkSection::Mentioned, &[], "me", MrListStatus::Open).unwrap();
        assert!(scopes
            .iter()
            .all(|scope| !scope.contains("with_labels_details")));
    }

    #[test]
    fn team_labels_union_separate_encoded_queries_and_empty_means_no_query() {
        let scopes = scope_endpoints(
            WorkSection::Team,
            &["team a".into(), "team&b".into()],
            "me",
            MrListStatus::Open,
        )
        .unwrap();
        assert_eq!(scopes.len(), 2);
        assert!(scopes[0].ends_with("labels=team%20a"));
        assert!(scopes[1].ends_with("labels=team%26b"));
        assert!(scope_endpoints(WorkSection::Team, &[], "me", MrListStatus::Open)
            .unwrap()
            .is_empty());
        for label in ["Any", "a,b"] {
            assert!(scope_endpoints(
                WorkSection::Team,
                &[label.into()],
                "me",
                MrListStatus::Open,
            )
            .is_err());
        }
    }

    #[test]
    fn mention_history_includes_done_and_direct_addressing() {
        let scopes = scope_endpoints(WorkSection::Mentioned, &[], "me", MrListStatus::Open).unwrap();
        assert_eq!(scopes.len(), 4);
        assert!(scopes
            .iter()
            .any(|s| s.contains("action=directly_addressed&state=done")));
        assert!(scopes.iter().all(|s| s.contains("type=MergeRequest")));
    }

    #[test]
    fn mentioned_mrs_exclude_current_assignees_reviewers_and_closed_items() {
        assert!(mention_is_other_work(&mr(), "me", MrListStatus::Open).unwrap());
        for key in ["assignees", "reviewers"] {
            let mut raw = mr();
            raw[key] = json!([{"username":"me"}]);
            assert!(!mention_is_other_work(&raw, "me", MrListStatus::Open).unwrap());
        }
        let mut closed = mr();
        closed["state"] = json!("merged");
        assert!(!mention_is_other_work(&closed, "me", MrListStatus::Open).unwrap());
        let mut unknown = mr();
        unknown.as_object_mut().unwrap().remove("reviewers");
        assert!(mention_is_other_work(&unknown, "me", MrListStatus::Open).is_err());
    }

    #[test]
    fn mr_status_queries_preserve_open_issues_and_label_details() {
        assert_eq!(MrListStatus::default(), MrListStatus::Open);
        assert_eq!(
            serde_json::from_value::<MrListStatus>(json!("merged")).unwrap(),
            MrListStatus::Merged
        );
        assert!(serde_json::from_value::<MrListStatus>(json!("closed")).is_err());
        for status in [MrListStatus::Open, MrListStatus::Merged] {
            let expected_state = if status == MrListStatus::Open {
                "state=opened"
            } else {
                "state=merged"
            };
            for section in [WorkSection::Mine, WorkSection::Authored, WorkSection::Team] {
                let scopes = scope_endpoints(section, &["team".into()], "me", status).unwrap();
                assert!(scopes.iter().all(|scope| scope.contains(expected_state)));
                assert!(scopes
                    .iter()
                    .all(|scope| scope.contains("with_labels_details=true")));
            }
            let issues = scope_endpoints(WorkSection::Issues, &[], "me", status).unwrap();
            assert!(issues.iter().all(|scope| scope.contains("state=opened")));
        }
    }

    #[test]
    fn mentioned_mrs_match_the_selected_state_and_keep_participant_exclusions() {
        for status in [MrListStatus::Open, MrListStatus::Merged] {
            for state in ["opened", "merged", "closed"] {
                let mut raw = mr();
                raw["state"] = json!(state);
                assert_eq!(
                    mention_is_other_work(&raw, "me", status).unwrap(),
                    state == status.gitlab_state()
                );
                raw["reviewers"] = json!([{"username": "me"}]);
                assert!(!mention_is_other_work(&raw, "me", status).unwrap());
            }
        }
    }

    #[test]
    fn watched_mr_urls_require_a_configured_host_and_a_real_mr_path() {
        let hosts = vec!["git.example.com".to_string()];
        let target = watch_target(
            " https://GIT.EXAMPLE.COM/a/sub/repo/-/merge_requests/7?diff_id=1#note_4 ",
            &hosts,
        )
        .unwrap();
        assert_eq!(target.host, "git.example.com");
        assert_eq!(target.project, "a/sub/repo");
        assert_eq!(target.iid, 7);
        assert_eq!(
            target.endpoint(),
            "projects/a%2Fsub%2Frepo/merge_requests/7?with_labels_details=true"
        );
        assert!(watch_target("http://git.example.com/a/repo/-/merge_requests/7", &hosts).is_ok());
        assert!(watch_target(
            "https://elsewhere.example.com/a/repo/-/merge_requests/7",
            &hosts,
        )
        .is_err());
        for url in [
            "",
            "javascript:alert(1)",
            "file:///a/repo/-/merge_requests/7",
            "ssh://git.example.com/a/repo/-/merge_requests/7",
            "git@git.example.com:a/repo/-/merge_requests/7",
            "https://user:secret@git.example.com/a/repo/-/merge_requests/7",
            "https://git.example.com:8443/a/repo/-/merge_requests/7",
            "https://git.example.com/a/repo/-/issues/7",
            "https://git.example.com/repo/-/merge_requests/7",
            "https://git.example.com/a/repo/-/merge_requests/0",
            "https://git.example.com/a/repo/-/merge_requests/seven",
            "https://git.example.com/a/repo/-/merge_requests/7/commits",
            "https://git.example.com/a/repo\\other/-/merge_requests/7",
            "https://git.example.com/a/repo/-/merge_requests/7\n?x=1",
        ] {
            assert!(watch_target(url, &hosts).is_err(), "must reject {url:?}");
        }
    }

    fn watched_raw(iid: u64, state: &str) -> Value {
        let mut raw = mr();
        raw["iid"] = json!(iid);
        raw["state"] = json!(state);
        raw["web_url"] = json!(format!("https://git.example.com/a/sub/repo/-/merge_requests/{iid}"));
        raw
    }

    #[test]
    fn watched_mr_responses_validate_identity_state_and_preserve_colors() {
        let hosts = vec!["git.example.com".to_string()];
        let target = watch_target(
            "https://git.example.com/a/sub/repo/-/merge_requests/7",
            &hosts,
        )
        .unwrap();
        for state in ["opened", "merged", "closed"] {
            let mut raw = watched_raw(7, state);
            raw["labels"] = json!([{"name": "team", "color": "#123ABC"}]);
            let watched = watched_mr_from_value(&raw, &target).unwrap();
            let wire = serde_json::to_value(watched).unwrap();
            assert_eq!(wire["state"], state);
            assert_eq!(wire["item"]["isPullRequest"], true);
            assert_eq!(wire["item"]["labels"], json!(["team"]));
            assert_eq!(wire["item"]["labelColors"], json!({"team": "123ABC"}));
        }
        for (key, value) in [
            ("state", json!("unknown")),
            ("state", json!(null)),
            ("iid", json!(8)),
            ("title", json!(null)),
            ("web_url", json!("https://git.example.com/a/sub/repo/-/issues/7")),
            (
                "web_url",
                json!("https://git.example.com/a/other/-/merge_requests/7"),
            ),
            (
                "web_url",
                json!("https://elsewhere.example.com/a/sub/repo/-/merge_requests/7"),
            ),
        ] {
            let mut raw = mr();
            raw[key] = value;
            assert!(
                watched_mr_from_value(&raw, &target).is_err(),
                "must reject {raw}"
            );
        }
    }

    #[tokio::test]
    async fn watched_reads_filter_states_dedupe_targets_and_keep_normal_rows_on_failure() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let hosts = vec!["git.example.com".to_string()];
        let mut urls = [7, 7, 8, 9, 10]
            .map(|iid| format!("https://git.example.com/a/sub/repo/-/merge_requests/{iid}"));
        urls[1].push_str("?diff_id=1#note_2");
        for status in [MrListStatus::Open, MrListStatus::Merged] {
            let calls = AtomicUsize::new(0);
            let watched = watched_items_with(&urls, &hosts, status, |host, endpoint| {
                calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(host, "git.example.com");
                assert!(endpoint.starts_with("projects/a%2Fsub%2Frepo/merge_requests/"));
                assert!(endpoint.ends_with("?with_labels_details=true"));
                let iid = endpoint
                    .split("merge_requests/")
                    .nth(1)
                    .unwrap()
                    .split('?')
                    .next()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap();
                async move {
                    match iid {
                        7 => Ok(watched_raw(7, "opened")),
                        8 => Ok(watched_raw(8, "merged")),
                        9 => Ok(watched_raw(9, "closed")),
                        _ => Err(unreadable("offline")),
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(
                calls.load(Ordering::SeqCst),
                4,
                "duplicate targets share one read"
            );
            assert!(watched.truncated);
            assert_eq!(watched.items.len(), 1);
            assert_eq!(
                watched.items[0].number,
                if status == MrListStatus::Open { 7 } else { 8 }
            );
        }

        let closed = watched_items_with(&urls[..1], &hosts, MrListStatus::Open, |_, _| async {
            Ok(watched_raw(7, "closed"))
        })
        .await
        .unwrap();
        assert!(closed.items.is_empty());
        assert!(!closed.truncated);

        let normal = || {
            merge_legs(
                vec![MyWorkLeg {
                    items: vec![gitlab::my_work_item_from_value(&mr(), true).unwrap()],
                    capped: false,
                }],
                MY_WORK_LIMIT,
            )
        };
        let watched = watched_items_with(&urls[..1], &hosts, MrListStatus::Open, |_, _| async {
            let mut raw = watched_raw(7, "opened");
            raw["web_url"] = json!("https://git.example.com/a/sub/repo/-/merge_requests/7?diff_id=1#note_2");
            Ok(raw)
        })
        .await;
        let page = fold_results(vec![Ok(normal()), watched]).unwrap();
        assert_eq!(page.items.len(), 1, "normal and watched hits dedupe");
        assert!(!page.truncated);

        let failed = watched_items_with(&urls[..1], &hosts, MrListStatus::Open, |_, _| async {
            Err(unreadable("offline"))
        })
        .await;
        let page = fold_results(vec![Ok(normal()), failed]).unwrap();
        assert_eq!(page.items.len(), 1, "failed watches preserve normal Mine rows");
        assert!(page.truncated);
    }

    #[tokio::test]
    async fn watched_reads_validate_hosts_and_limit_requests_before_fetching() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = AtomicUsize::new(0);
        let url = "https://git.example.com/a/sub/repo/-/merge_requests/7".to_string();
        assert!(validate_watch_count(&vec![url.clone(); MAX_WATCHED_MRS]).is_ok());
        for (urls, hosts) in [
            (vec![url.clone()], vec!["elsewhere.example.com".to_string()]),
            (
                vec![url; MAX_WATCHED_MRS + 1],
                vec!["git.example.com".to_string()],
            ),
        ] {
            let result = watched_items_with(&urls, &hosts, MrListStatus::Open, |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Ok(mr()) }
            })
            .await;
            assert!(result.is_err());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn watched_reads_use_bounded_concurrency() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let hosts = vec!["git.example.com".to_string()];
        let urls: Vec<String> = (1..=9)
            .map(|iid| format!("https://git.example.com/a/sub/repo/-/merge_requests/{iid}"))
            .collect();
        let page = watched_items_with(&urls, &hosts, MrListStatus::Open, |_, endpoint| {
            let active = &active;
            let peak = &peak;
            async move {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                tokio::task::yield_now().await;
                let iid = endpoint
                    .split("merge_requests/")
                    .nth(1)
                    .unwrap()
                    .split('?')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap();
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(watched_raw(iid, "opened"))
            }
        })
        .await
        .unwrap();
        assert_eq!(page.items.len(), 9);
        assert_eq!(peak.load(Ordering::SeqCst), CONCURRENCY);
    }

    #[test]
    fn todos_preserve_distinct_ids_and_large_ids_as_strings() {
        let base = json!({"id":9007199254740993u64,"action_name":"mentioned","target_type":"MergeRequest","target":mr(),"target_url":"https://git.example.com/a/sub/repo/-/merge_requests/7#note_12","body":"Review me","state":"pending"});
        let todo = parse_todo(&base, "git.example.com").unwrap();
        assert_eq!(todo.id, "9007199254740993");
        assert_eq!(todo.item.unwrap().repo_full_name, "a/sub/repo");
        assert!(todo.url.ends_with("#note_12"));
        let mut bad = base;
        bad["target_url"] = json!("https://another.example.com/a/repo");
        assert!(parse_todo(&bad, "git.example.com").is_none());
    }

    #[test]
    fn todo_targets_keep_label_names_and_reported_colors() {
        let mut target = mr();
        target["labels"] = json!([{"name": "review", "color": "#123AbC"}, "legacy"]);
        let raw = json!({
            "id": 12,
            "target_type": "MergeRequest",
            "target": target,
            "target_url": "https://git.example.com/a/sub/repo/-/merge_requests/7#note_12"
        });
        let todo = parse_todo(&raw, "git.example.com").expect("maps todo");
        let wire = serde_json::to_value(todo).expect("serializes");
        assert_eq!(wire["item"]["labels"], json!(["review", "legacy"]));
        assert_eq!(wire["item"]["labelColors"], json!({"review": "123AbC"}));
    }
}
