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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkSection {
    Mine,
    Authored,
    Team,
    Mentioned,
    Issues,
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
) -> AppResult<Vec<String>> {
    let base = "state=opened&order_by=updated_at&sort=desc&per_page=100";
    let viewer = encode_query_value(viewer);
    Ok(match section {
        WorkSection::Mine => vec![
            format!("merge_requests?{base}&scope=assigned_to_me"),
            format!("merge_requests?{base}&scope=all&reviewer_username={viewer}"),
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

fn mention_is_other_work(raw: &Value, viewer: &str) -> AppResult<bool> {
    if raw.get("state").and_then(Value::as_str) != Some("opened") {
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

async fn host_items(host: &str, section: WorkSection, labels: &[String]) -> AppResult<MyWorkPage> {
    let user = read_json(host, "user").await?;
    let viewer = user
        .get("username")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| unreadable("GitLab did not report your username."))?;
    let scopes = scope_endpoints(section, labels, viewer)?;
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
                let raw =
                    read_json(host, &format!("projects/{project}/merge_requests/{iid}")).await?;
                Ok::<_, AppError>(if mention_is_other_work(&raw, viewer)? {
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
pub async fn gitlab_work_items(section: WorkSection, labels: Vec<String>) -> AppResult<MyWorkPage> {
    // Validate before touching the network, including the unconfigured team state.
    scope_endpoints(section, &labels, "viewer")?;
    if section == WorkSection::Team && labels.is_empty() {
        return Ok(MyWorkPage::empty());
    }
    let hosts = gitlab_work_hosts().await;
    if hosts.is_empty() {
        return Ok(MyWorkPage::empty());
    }
    let results =
        futures_join_all(hosts.iter().map(|host| host_items(host, section, &labels))).await;
    fold_results(results)
}

fn fold_results(results: Vec<AppResult<MyWorkPage>>) -> AppResult<MyWorkPage> {
    let mut legs = Vec::new();
    let mut failure = None;
    for result in results {
        match result {
            Ok(page) => legs.push(MyWorkLeg {
                items: page.items,
                capped: page.truncated,
            }),
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
    fn personal_mrs_are_assigned_or_reviewed_not_authored() {
        let scopes = scope_endpoints(WorkSection::Mine, &[], "me").unwrap();
        assert_eq!(scopes.len(), 2);
        assert!(scopes[0].contains("scope=assigned_to_me"));
        assert!(scopes[1].contains("scope=all&reviewer_username=me"));
        assert!(!scopes.iter().any(|s| s.contains("created_by_me")));
    }

    #[test]
    fn team_labels_union_separate_encoded_queries_and_empty_means_no_query() {
        let scopes =
            scope_endpoints(WorkSection::Team, &["team a".into(), "team&b".into()], "me").unwrap();
        assert_eq!(scopes.len(), 2);
        assert!(scopes[0].ends_with("labels=team%20a"));
        assert!(scopes[1].ends_with("labels=team%26b"));
        assert!(scope_endpoints(WorkSection::Team, &[], "me")
            .unwrap()
            .is_empty());
        assert!(scope_endpoints(WorkSection::Team, &["Any".into()], "me").is_err());
        assert!(scope_endpoints(WorkSection::Team, &["a,b".into()], "me").is_err());
    }

    #[test]
    fn mention_history_includes_done_and_direct_addressing() {
        let scopes = scope_endpoints(WorkSection::Mentioned, &[], "me").unwrap();
        assert_eq!(scopes.len(), 4);
        assert!(scopes
            .iter()
            .any(|s| s.contains("action=directly_addressed&state=done")));
        assert!(scopes.iter().all(|s| s.contains("type=MergeRequest")));
    }

    #[test]
    fn mentioned_mrs_exclude_current_assignees_reviewers_and_closed_items() {
        assert!(mention_is_other_work(&mr(), "me").unwrap());
        for key in ["assignees", "reviewers"] {
            let mut raw = mr();
            raw[key] = json!([{"username":"me"}]);
            assert!(!mention_is_other_work(&raw, "me").unwrap());
        }
        let mut closed = mr();
        closed["state"] = json!("merged");
        assert!(!mention_is_other_work(&closed, "me").unwrap());
        let mut unknown = mr();
        unknown.as_object_mut().unwrap().remove("reviewers");
        assert!(mention_is_other_work(&unknown, "me").is_err());
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
}
