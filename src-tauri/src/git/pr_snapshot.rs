use std::future::Future;

use crate::error::{AppError, AppResult};
use crate::forge::model::Provider;
use crate::git::diff::{finish_preview, is_repo_relative, FileBytes, PreviewRead, IMAGE_MAX_BYTES};
use crate::git::ops::PathListingEntry;
use crate::git::pr_checkout::{
    checkout_source, fetch_credentials, FetchFrom, PrCheckoutSource, SourceRef,
};
use crate::git::remote::run_git_with_creds_once;
use crate::git::runner::{
    acquire_repo_lock, holder_label, run_git_raw_env, worktree_toplevel, GitOutput,
    DEFAULT_TIMEOUT, NETWORK_LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT,
};
use crate::git::worktree::stdout_path;
use crate::state::AppState;

// Patched Git versions honour this for promisor reads; blob_sizes uses the same gate.
const NO_LAZY_FETCH: [(&str, &str); 1] = [("GIT_NO_LAZY_FETCH", "1")];
const COMPARISON_PATCH_INPUT_MAX_BYTES: u64 = 1024 * 1024;
const COMPARISON_PATCH_OUTPUT_MAX_BYTES: usize = 2 * 1024 * 1024;

struct SnapshotRequest {
    repo_path: String,
    number: u64,
    head_sha: String,
    lens: Option<String>,
    remote: &'static str,
}

impl SnapshotRequest {
    fn new(
        repo_path: String,
        number: u64,
        head_sha: String,
        lens: Option<String>,
    ) -> AppResult<Self> {
        if repo_path.is_empty() || number == 0 {
            return Err(AppError::InvalidArgument(
                "A repository and merge/pull request number are required.".into(),
            ));
        }
        let head_sha = snapshot_head_sha(&head_sha)?;
        let remote = crate::github::lens_remote(lens.as_deref())?;
        Ok(Self {
            repo_path,
            number,
            head_sha,
            lens,
            remote,
        })
    }
}

fn snapshot_head_sha(head_sha: &str) -> AppResult<String> {
    if !matches!(head_sha.len(), 40 | 64) || !head_sha.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::InvalidArgument(
            "The snapshot needs the full merge/pull request head commit ID.".into(),
        ));
    }
    Ok(head_sha.to_ascii_lowercase())
}

fn validate_forge_lens(provider: Option<Provider>, remote: &str) -> AppResult<()> {
    if remote == "upstream" && matches!(provider, Some(Provider::GitLab | Provider::Bitbucket)) {
        return Err(AppError::InvalidArgument(
            "The upstream repository lens is currently supported for GitHub only.".into(),
        ));
    }
    Ok(())
}

fn snapshot_paths(stdout: &[u8]) -> AppResult<Vec<PathListingEntry>> {
    if !stdout.is_empty() && stdout.last() != Some(&0) {
        return Err(AppError::Command(
            "Git returned an incomplete snapshot file listing.".into(),
        ));
    }
    Ok(stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| PathListingEntry {
            path: String::from_utf8_lossy(path).into_owned(),
            undecodable: std::str::from_utf8(path).is_err(),
        })
        .collect())
}

/// No checkout, index, branch, tracking-ref or FETCH_HEAD writes. A fetched newer
/// MR head only supplies objects: the requested commit remains the snapshot.
#[tauri::command]
pub async fn git_pr_snapshot_files(
    state: tauri::State<'_, AppState>,
    repo_path: String,
    number: u64,
    head_sha: String,
    lens: Option<String>,
) -> AppResult<Vec<PathListingEntry>> {
    let request = SnapshotRequest::new(repo_path, number, head_sha, lens)?;
    let provider = crate::forge::detect_non_github(&request.repo_path)
        .await
        .map(|(provider, _)| provider);
    validate_forge_lens(provider, request.remote)?;
    let forge = match provider {
        Some(Provider::GitLab) => "GitLab",
        Some(Provider::Bitbucket) => "Bitbucket",
        Some(Provider::GitHub) | None => "GitHub",
    };
    snapshot_files_core(&state, &request, || {
        checkout_source(
            &request.repo_path,
            request.number,
            forge,
            request.lens.as_deref(),
        )
    })
    .await
}

async fn local_snapshot_read(repo_path: &str, args: &[&str]) -> AppResult<GitOutput> {
    let mut raw_args = vec!["--no-replace-objects"];
    raw_args.extend_from_slice(args);
    run_git_raw_env(Some(repo_path), &raw_args, &NO_LAZY_FETCH, DEFAULT_TIMEOUT)
        .await?
        .exit_verdict()
}

async fn requested_commit_present(repo_path: &str, sha: &str) -> AppResult<bool> {
    let ambiguous = || {
        AppError::InvalidArgument(
            "The requested commit ID also names a ref, so the snapshot is ambiguous.".into(),
        )
    };
    let loose_path = local_snapshot_read(
        repo_path,
        &["rev-parse", "--path-format=absolute", "--git-path", sha],
    )
    .await?
    .stdout_lossy();
    match tokio::fs::symlink_metadata(stdout_path(&loose_path)).await {
        Ok(_) => return Err(ambiguous()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let ambiguous_refs = [
        format!("refs/{sha}"),
        format!("refs/tags/{sha}"),
        format!("refs/heads/{sha}"),
        format!("refs/remotes/{sha}"),
        format!("refs/remotes/{sha}/HEAD"),
    ];
    let mut args = vec!["for-each-ref", "--format=%(refname)"];
    args.extend(ambiguous_refs.iter().map(String::as_str));
    let refs = local_snapshot_read(repo_path, &args).await?;
    if refs
        .stdout_lossy()
        .lines()
        .any(|name| ambiguous_refs.iter().any(|candidate| candidate == name))
    {
        return Err(ambiguous());
    }
    if !object_is_local(repo_path, sha).await? {
        return Ok(false);
    }
    let kind = local_snapshot_read(repo_path, &["cat-file", "-t", sha]).await?;
    if kind.stdout_lossy().trim() != "commit" {
        return Err(AppError::InvalidArgument(
            "The requested snapshot object is not a commit.".into(),
        ));
    }
    Ok(true)
}

async fn object_is_local(repo_path: &str, oid: &str) -> AppResult<bool> {
    // Disambiguation inspects local object IDs without resolving refs or fetching.
    let prefix = format!("--disambiguate={oid}");
    let found = local_snapshot_read(repo_path, &["rev-parse", &prefix]).await?;
    let found = found.stdout_lossy();
    if found.trim().is_empty() {
        return Ok(false);
    }
    if found.trim() != oid {
        return Err(AppError::InvalidArgument(
            "The snapshot object ID does not identify one exact object.".into(),
        ));
    }
    Ok(true)
}

fn provider_head_ref(source: &SourceRef, number: u64) -> AppResult<String> {
    match source {
        SourceRef::PullHead(found) if *found == number => Ok(format!("refs/pull/{number}/head")),
        SourceRef::MergeRequestHead(found) if *found == number => {
            Ok(format!("refs/merge-requests/{number}/head"))
        }
        SourceRef::Branch(branch) => {
            crate::git::branches::validate_ref_name(branch)?;
            Ok(format!("refs/heads/{branch}"))
        }
        _ => Err(AppError::InvalidArgument(
            "The fetched head belongs to another merge/pull request.".into(),
        )),
    }
}

async fn fetch_snapshot_objects(
    repo_path: &str,
    from: &str,
    source: &str,
    credentials: &[String],
) -> AppResult<crate::git::runner::GitOutput> {
    let args = snapshot_fetch_args(from, &[source], false);
    run_git_with_creds_once(repo_path, credentials, &args, NETWORK_TIMEOUT).await
}

fn snapshot_fetch_args<'a>(from: &'a str, sources: &[&'a str], trees_only: bool) -> Vec<&'a str> {
    // Explicit source without a destination, empty refmap, and no pruning keep
    // remote fetch configuration from updating refs; FETCH_HEAD stays untouched.
    let mut args = vec![
        "fetch",
        "--no-tags",
        "--no-prune",
        "--no-prune-tags",
        "--no-write-fetch-head",
        "--refmap=",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
    ];
    if trees_only {
        args.push("--filter=blob:none");
    }
    args.push(from);
    args.extend_from_slice(sources);
    args
}

async fn hydrate_snapshot_objects(
    state: &AppState,
    repo_path: &str,
    remote: &str,
    objects: &[String],
    trees_only: bool,
) -> AppResult<()> {
    let top = worktree_toplevel(repo_path).await?;
    let domain = state.network_lock(repo_path).await;
    let _hold =
        acquire_repo_lock(&domain, NETWORK_LOCK_WAIT_TIMEOUT, holder_label("fetch")).await?;
    if worktree_toplevel(repo_path).await? != top {
        return Err(AppError::InvalidArgument(
            "The repository changed before its snapshot could be fetched.".into(),
        ));
    }
    let mut missing = Vec::new();
    for oid in objects {
        if !object_is_local(repo_path, oid).await? {
            missing.push(oid.as_str());
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    let credentials = crate::forge::credential_config_for_remote(repo_path, remote).await?;
    for chunk in missing.chunks(64) {
        // A promisor's local commits must not convince negotiation that its
        // missing trees/blobs are already available. No history is requested.
        let mut args = vec!["-c", "fetch.negotiationAlgorithm=noop"];
        args.extend(snapshot_fetch_args(remote, chunk, trees_only));
        run_git_with_creds_once(repo_path, &credentials, &args, NETWORK_TIMEOUT)
            .await?
            .exit_verdict()?;
        for oid in chunk {
            if !object_is_local(repo_path, oid).await? {
                return Err(AppError::InvalidArgument(
                    "A requested snapshot object is unavailable after fetching.".into(),
                ));
            }
        }
    }
    Ok(())
}

async fn missing_snapshot_trees(repo_path: &str, head_sha: &str) -> AppResult<Vec<String>> {
    // No commit walk and no blobs: report only this commit's missing tree frontier,
    // including nested gaps beneath an already-local root, without lazy fetches.
    let listing = local_snapshot_read(
        repo_path,
        &[
            "rev-list",
            "--objects",
            "--no-walk",
            "--no-object-names",
            "--missing=print",
            "--filter=blob:none",
            head_sha,
        ],
    )
    .await?;
    let text = std::str::from_utf8(&listing.stdout)
        .map_err(|_| AppError::Command("Git returned unreadable snapshot tree IDs.".into()))?;
    if text.is_empty() {
        return Err(AppError::Command(
            "Git returned no snapshot tree traversal.".into(),
        ));
    }
    let mut missing = Vec::new();
    for line in text.lines() {
        let oid = line.strip_prefix('?').unwrap_or(line);
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::Command(
                "Git returned an invalid snapshot tree ID.".into(),
            ));
        }
        if line.starts_with('?') {
            missing.push(oid.to_ascii_lowercase());
        }
    }
    Ok(missing)
}

async fn ensure_snapshot_trees(
    state: &AppState,
    repo_path: &str,
    head_sha: &str,
    remote: &str,
) -> AppResult<()> {
    let missing = missing_snapshot_trees(repo_path, head_sha).await?;
    if !missing.is_empty() {
        hydrate_snapshot_objects(state, repo_path, remote, &missing, true).await?;
        if !missing_snapshot_trees(repo_path, head_sha)
            .await?
            .is_empty()
        {
            return Err(AppError::InvalidArgument(
                "The requested snapshot tree remains incomplete after fetching.".into(),
            ));
        }
    }
    Ok(())
}

async fn ensure_snapshot_commit<F, Fut>(
    state: &AppState,
    request: &SnapshotRequest,
    resolve_source: F,
) -> AppResult<()>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AppResult<PrCheckoutSource>>,
{
    if requested_commit_present(&request.repo_path, &request.head_sha).await? {
        return Ok(());
    }
    let top = worktree_toplevel(&request.repo_path).await?;
    let domain = state.network_lock(&request.repo_path).await;
    let _hold =
        acquire_repo_lock(&domain, NETWORK_LOCK_WAIT_TIMEOUT, holder_label("fetch")).await?;
    if worktree_toplevel(&request.repo_path).await? != top {
        return Err(AppError::InvalidArgument(
            "The repository changed before its snapshot could be fetched.".into(),
        ));
    }
    if requested_commit_present(&request.repo_path, &request.head_sha).await? {
        return Ok(());
    }
    let credentials =
        crate::forge::credential_config_for_remote(&request.repo_path, request.remote).await?;
    fetch_snapshot_objects(
        &request.repo_path,
        request.remote,
        &request.head_sha,
        &credentials,
    )
    .await?;
    if requested_commit_present(&request.repo_path, &request.head_sha).await? {
        return Ok(());
    }

    let source = resolve_source().await?;
    let from = match &source.from {
        FetchFrom::Remote(remote) if *remote == request.remote => *remote,
        FetchFrom::BitbucketUrl(url) if request.remote == "origin" => url.as_str(),
        _ => {
            return Err(AppError::InvalidArgument(
                "The fetched head belongs to another repository lens.".into(),
            ))
        }
    };
    let credentials = fetch_credentials(&request.repo_path, &source.from).await?;
    let head_ref = provider_head_ref(&source.source_ref, request.number)?;
    let fetched = fetch_snapshot_objects(&request.repo_path, from, &head_ref, &credentials).await?;
    if requested_commit_present(&request.repo_path, &request.head_sha).await? {
        return Ok(());
    }
    if fetched.code != 0 {
        return fetched.exit_verdict().map(|_| ());
    }
    Err(AppError::InvalidArgument(
        "The requested merge/pull request commit is unavailable after fetching its head. Reload the request and try again.".into(),
    ))
}

async fn snapshot_files_core<F, Fut>(
    state: &AppState,
    request: &SnapshotRequest,
    resolve_source: F,
) -> AppResult<Vec<PathListingEntry>>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AppResult<PrCheckoutSource>>,
{
    ensure_snapshot_commit(state, request, resolve_source).await?;
    ensure_snapshot_trees(state, &request.repo_path, &request.head_sha, request.remote).await?;
    let listing = local_snapshot_read(
        &request.repo_path,
        &[
            "ls-tree",
            "--full-tree",
            "-r",
            "--name-only",
            "-z",
            &request.head_sha,
            "--",
        ],
    )
    .await?;
    snapshot_paths(&listing.stdout)
}

/// Exact snapshot bytes, hydrating only missing tree/blob objects without a checkout.
#[tauri::command]
pub async fn git_pr_snapshot_file(
    state: tauri::State<'_, AppState>,
    repo_path: String,
    head_sha: String,
    file_path: String,
    lens: Option<String>,
) -> AppResult<Option<FileBytes>> {
    let remote = crate::github::lens_remote(lens.as_deref())?;
    let provider = crate::forge::detect_non_github(&repo_path)
        .await
        .map(|(provider, _)| provider);
    validate_forge_lens(provider, remote)?;
    snapshot_file_core(&state, &repo_path, &head_sha, &file_path, remote).await
}

async fn snapshot_file_core(
    state: &AppState,
    repo_path: &str,
    head_sha: &str,
    file_path: &str,
    remote: &str,
) -> AppResult<Option<FileBytes>> {
    let head_sha = snapshot_head_sha(head_sha)?;
    if repo_path.is_empty() {
        return Err(AppError::InvalidArgument(
            "The snapshot file needs a safe repository-relative path.".into(),
        ));
    }
    validate_snapshot_file_path(file_path)?;
    if !requested_commit_present(repo_path, &head_sha).await? {
        return Err(AppError::InvalidArgument(
            "The requested snapshot commit is not available locally. Reload the request and try again.".into(),
        ));
    }
    ensure_snapshot_trees(state, repo_path, &head_sha, remote).await?;
    let spec = format!("{head_sha}:{file_path}");
    let resolved = local_snapshot_read(repo_path, &["rev-parse", "--verify", &spec]).await?;
    let oid = resolved.stdout_lossy().trim().to_string();
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::Command(
            "Git returned an invalid snapshot blob ID.".into(),
        ));
    }
    if !object_is_local(repo_path, &oid).await? {
        hydrate_snapshot_objects(state, repo_path, remote, std::slice::from_ref(&oid), false)
            .await?;
    }
    let kind = local_snapshot_read(repo_path, &["cat-file", "-t", &oid]).await?;
    if kind.stdout_lossy().trim() != "blob" {
        return Err(AppError::InvalidArgument(
            "The selected snapshot entry is not a file.".into(),
        ));
    }
    let size = local_snapshot_read(repo_path, &["cat-file", "-s", &oid])
        .await?
        .stdout_lossy()
        .trim()
        .parse::<u64>()
        .map_err(|_| AppError::Command("Git returned an unreadable snapshot file size.".into()))?;
    if size > IMAGE_MAX_BYTES as u64 {
        return finish_preview(PreviewRead::TooLarge(size));
    }
    let bytes = local_snapshot_read(repo_path, &["cat-file", "blob", &oid]).await?;
    finish_preview(PreviewRead::Bytes(bytes.stdout, Some(size)))
}

fn validate_snapshot_file_path(file_path: &str) -> AppResult<()> {
    if file_path.is_empty()
        || file_path.contains('\0')
        || !is_repo_relative(file_path)
        || file_path
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(AppError::InvalidArgument(
            "The snapshot file needs a safe repository-relative path.".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotComparison {
    pub base_sha: String,
    pub head_sha: String,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub before: Option<FileBytes>,
    pub after: Option<FileBytes>,
    pub patch: Option<String>,
}

struct ComparisonMetadata {
    base_sha: String,
    head_sha: String,
    old_path: Option<String>,
    new_path: Option<String>,
}

fn comparison_metadata(
    body: &str,
    number: u64,
    head_sha: &str,
    file_path: &str,
) -> AppResult<ComparisonMetadata> {
    #[derive(serde::Deserialize)]
    struct DiffRefs {
        base_sha: String,
        head_sha: String,
    }
    #[derive(serde::Deserialize)]
    struct Payload {
        iid: u64,
        diff_refs: DiffRefs,
        changes: Vec<serde_json::Value>,
    }
    #[derive(serde::Deserialize)]
    struct Change {
        old_path: String,
        new_path: String,
        new_file: bool,
        deleted_file: bool,
        renamed_file: bool,
    }
    let incomplete = || {
        AppError::InvalidArgument(
        "GitLab did not provide complete comparison metadata for this file. Reload the merge request and try again.".into(),
    )
    };
    validate_snapshot_file_path(file_path)?;
    let expected_head = snapshot_head_sha(head_sha)?;
    let payload: Payload = serde_json::from_str(body).map_err(|_| incomplete())?;
    if number == 0 || payload.iid != number {
        return Err(incomplete());
    }
    let base_sha = snapshot_head_sha(&payload.diff_refs.base_sha).map_err(|_| incomplete())?;
    let head_sha = snapshot_head_sha(&payload.diff_refs.head_sha).map_err(|_| incomplete())?;
    if head_sha != expected_head {
        return Err(AppError::InvalidArgument(
            "The merge request head changed. Reload the request before comparing the full file."
                .into(),
        ));
    }
    let mut matching = payload.changes.into_iter().filter(|change| {
        let path = change
            .get("new_path")
            .and_then(serde_json::Value::as_str)
            .filter(|path| !path.is_empty())
            .or_else(|| change.get("old_path").and_then(serde_json::Value::as_str));
        path == Some(file_path)
    });
    let change = matching.next().ok_or_else(incomplete)?;
    if matching.next().is_some() {
        return Err(incomplete());
    }
    let change: Change = serde_json::from_value(change).map_err(|_| incomplete())?;
    validate_snapshot_file_path(&change.old_path)?;
    validate_snapshot_file_path(&change.new_path)?;
    if (change.new_file && change.deleted_file)
        || (change.renamed_file
            && (change.new_file || change.deleted_file || change.old_path == change.new_path))
        || (!change.renamed_file && change.old_path != change.new_path)
    {
        return Err(incomplete());
    }
    Ok(ComparisonMetadata {
        base_sha,
        head_sha,
        old_path: (!change.new_file).then_some(change.old_path),
        new_path: (!change.deleted_file).then_some(change.new_path),
    })
}

/// Complete committed before/after bytes, pinned by one GitLab changes response.
#[tauri::command]
pub async fn git_pr_snapshot_comparison(
    state: tauri::State<'_, AppState>,
    repo_path: String,
    number: u64,
    head_sha: String,
    file_path: String,
    lens: Option<String>,
) -> AppResult<SnapshotComparison> {
    let request = SnapshotRequest::new(repo_path, number, head_sha, lens)?;
    validate_snapshot_file_path(&file_path)?;
    let provider = crate::forge::detect_non_github(&request.repo_path)
        .await
        .map(|(provider, _)| provider);
    snapshot_comparison_core(&state, &request, &file_path, provider, || {
        crate::forge::gitlab::mr_snapshot_comparison_metadata(&request.repo_path, request.number)
    })
    .await
}

async fn snapshot_comparison_core<F, Fut>(
    state: &AppState,
    request: &SnapshotRequest,
    file_path: &str,
    provider: Option<Provider>,
    resolve_metadata: F,
) -> AppResult<SnapshotComparison>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AppResult<String>>,
{
    validate_forge_lens(provider, request.remote)?;
    if !matches!(provider, Some(Provider::GitLab)) {
        return Err(AppError::InvalidArgument(
            "Full-file before/after comparison is currently available for GitLab merge requests only.".into(),
        ));
    }
    validate_snapshot_file_path(file_path)?;
    let body = resolve_metadata().await?;
    let metadata = comparison_metadata(&body, request.number, &request.head_sha, file_path)?;
    let base = SnapshotRequest::new(
        request.repo_path.clone(),
        request.number,
        metadata.base_sha.clone(),
        request.lens.clone(),
    )?;
    for commit in [&base, request] {
        ensure_snapshot_commit(state, commit, || {
            checkout_source(
                &commit.repo_path,
                commit.number,
                "GitLab",
                commit.lens.as_deref(),
            )
        })
        .await?;
        ensure_snapshot_trees(state, &commit.repo_path, &commit.head_sha, commit.remote).await?;
    }
    let required_side = || {
        AppError::InvalidArgument(
        "A committed file required by the merge request comparison is unavailable. Reload the request and try again.".into(),
    )
    };
    let before = match metadata.old_path.as_deref() {
        Some(path) => Some(
            snapshot_file_core(
                state,
                &request.repo_path,
                &metadata.base_sha,
                path,
                request.remote,
            )
            .await?
            .ok_or_else(required_side)?,
        ),
        None => None,
    };
    let after = match metadata.new_path.as_deref() {
        Some(path) => Some(
            snapshot_file_core(
                state,
                &request.repo_path,
                &metadata.head_sha,
                path,
                request.remote,
            )
            .await?
            .ok_or_else(required_side)?,
        ),
        None => None,
    };
    let patch = comparison_patch(
        &request.repo_path,
        &metadata,
        before.as_ref(),
        after.as_ref(),
    )
    .await?;
    Ok(SnapshotComparison {
        base_sha: metadata.base_sha,
        head_sha: metadata.head_sha,
        old_path: metadata.old_path,
        new_path: metadata.new_path,
        before,
        after,
        patch,
    })
}

async fn comparison_patch(
    repo_path: &str,
    metadata: &ComparisonMetadata,
    before: Option<&FileBytes>,
    after: Option<&FileBytes>,
) -> AppResult<Option<String>> {
    let (Some(before), Some(after), Some(old_path), Some(new_path)) = (
        before,
        after,
        metadata.old_path.as_deref(),
        metadata.new_path.as_deref(),
    ) else {
        // A proven addition/deletion needs no alignment algorithm: the caller
        // builds its complete one-sided view from the verified content bytes.
        return Ok(None);
    };
    if [before, after].into_iter().any(|file| {
        file.too_large
            || file.base64.is_none()
            || !file
                .size
                .is_some_and(|size| size <= COMPARISON_PATCH_INPUT_MAX_BYTES)
    }) {
        return Ok(None);
    }
    let old = format!("{}:{old_path}", metadata.base_sha);
    let new = format!("{}:{new_path}", metadata.head_sha);
    let patch = local_snapshot_read(
        repo_path,
        &[
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=999999",
            &old,
            &new,
        ],
    )
    .await?;
    if patch.stdout.len() > COMPARISON_PATCH_OUTPUT_MAX_BYTES {
        return Ok(None);
    }
    Ok(String::from_utf8(patch.stdout).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::pr_checkout::{FetchFrom, SourceRef};
    use crate::git::runner::{run_git, run_git_raw, TEST_GIT_HANG_GUARD};
    use base64::Engine;
    use std::path::Path;

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap_or_else(|error| panic!("{args:?}: {error:?}"))
            .stdout_lossy()
            .trim_end()
            .to_string()
    }

    async fn repository(path: &Path) -> String {
        std::fs::create_dir_all(path).unwrap();
        let repo = path.to_string_lossy().into_owned();
        run(&repo, &["init", "-q", "-b", "main"]).await;
        run(&repo, &["config", "user.name", "Snapshot test"]).await;
        run(&repo, &["config", "user.email", "snapshot@test.local"]).await;
        run(&repo, &["config", "commit.gpgSign", "false"]).await;
        repo
    }

    async fn commit(repo: &str, name: &str) -> String {
        std::fs::write(Path::new(repo).join(name), format!("{name}\n")).unwrap();
        run(repo, &["add", "-A"]).await;
        run(repo, &["commit", "-qm", name]).await;
        run(repo, &["rev-parse", "HEAD"]).await
    }

    async fn unavailable_source() -> AppResult<PrCheckoutSource> {
        panic!("this snapshot must not need the forge source lookup")
    }

    fn request(repo: &str, sha: &str) -> SnapshotRequest {
        SnapshotRequest::new(repo.into(), 7, sha.into(), Some("origin".into())).unwrap()
    }

    fn paths(rows: Vec<PathListingEntry>) -> Vec<String> {
        rows.into_iter().map(|row| row.path).collect()
    }

    async fn source_file(repo: &str, head: &str, path: &str) -> AppResult<Option<FileBytes>> {
        snapshot_file_core(&AppState::default(), repo, head, path, "origin").await
    }

    const COMPARISON_BEFORE: &str =
        "unchanged leading context\nold value\nunchanged trailing context\n";
    const COMPARISON_AFTER: &str =
        "unchanged leading context\nnew value\nunchanged trailing context\n";

    fn comparison_change(old_path: &str, new_path: &str) -> serde_json::Value {
        serde_json::json!({
            "old_path": old_path,
            "new_path": new_path,
            "new_file": false,
            "deleted_file": false,
            "renamed_file": old_path != new_path,
            // Deliberately incomplete: committed bytes, not these hunks, own both sides.
            "diff": "@@ -2 +2 @@\n-old value\n+new value",
            "collapsed": true,
            "too_large": true
        })
    }

    fn comparison_payload(base: &str, head: &str, change: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "iid": 7,
            "diff_refs": { "base_sha": base, "head_sha": head },
            "changes": [change]
        })
    }

    async fn comparison_fixture() -> (tempfile::TempDir, String, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(&dir.path().join("repo")).await;
        for (name, bytes) in [
            ("modified.txt", COMPARISON_BEFORE),
            ("deleted.txt", "entire deleted contents\n"),
            ("old-name.txt", "entire before rename\n"),
            ("pure-old.txt", "unchanged pure rename contents\n"),
        ] {
            std::fs::write(Path::new(&repo).join(name), bytes).unwrap();
        }
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "comparison base"]).await;
        let base = run(&repo, &["rev-parse", "HEAD"]).await;
        std::fs::write(Path::new(&repo).join("modified.txt"), COMPARISON_AFTER).unwrap();
        std::fs::remove_file(Path::new(&repo).join("deleted.txt")).unwrap();
        std::fs::rename(
            Path::new(&repo).join("old-name.txt"),
            Path::new(&repo).join("new-name.txt"),
        )
        .unwrap();
        std::fs::write(
            Path::new(&repo).join("new-name.txt"),
            "entire after rename\n",
        )
        .unwrap();
        std::fs::write(
            Path::new(&repo).join("old-name.txt"),
            "new file at renamed-away path\n",
        )
        .unwrap();
        std::fs::rename(
            Path::new(&repo).join("pure-old.txt"),
            Path::new(&repo).join("pure-new.txt"),
        )
        .unwrap();
        std::fs::write(
            Path::new(&repo).join("added.txt"),
            "entire added contents\n",
        )
        .unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "comparison head"]).await;
        let head = run(&repo, &["rev-parse", "HEAD"]).await;
        commit(&repo, "unrelated-local.txt").await;
        std::fs::write(
            Path::new(&repo).join("modified.txt"),
            "unrelated local index bytes\n",
        )
        .unwrap();
        run(&repo, &["add", "modified.txt"]).await;
        std::fs::write(Path::new(&repo).join(".git/FETCH_HEAD"), "keep this\n").unwrap();
        (dir, repo, base, head)
    }

    fn comparison_bytes(file: Option<FileBytes>) -> Vec<u8> {
        let file = file.expect("the committed comparison side exists");
        assert!(!file.too_large);
        base64::engine::general_purpose::STANDARD
            .decode(file.base64.unwrap())
            .unwrap()
    }

    #[tokio::test]
    async fn comparison_reads_complete_base_and_head_contents_instead_of_patch_or_index() {
        let (_dir, repo, base, head) = comparison_fixture().await;
        let body = comparison_payload(
            &base,
            &head,
            comparison_change("modified.txt", "modified.txt"),
        );
        let before_state = repository_state(&repo).await;
        let result = snapshot_comparison_core(
            &AppState::default(),
            &request(&repo, &head),
            "modified.txt",
            Some(Provider::GitLab),
            || async { Ok(body.to_string()) },
        )
        .await
        .unwrap();

        assert_eq!(result.base_sha, base);
        assert_eq!(result.head_sha, head);
        assert_eq!(result.old_path.as_deref(), Some("modified.txt"));
        assert_eq!(result.new_path.as_deref(), Some("modified.txt"));
        let patch = result
            .patch
            .as_deref()
            .expect("a patch from the pinned objects");
        assert!(patch.contains(" unchanged leading context\n"), "{patch}");
        assert!(patch.contains("-old value\n"), "{patch}");
        assert!(patch.contains("+new value\n"), "{patch}");
        assert!(patch.contains(" unchanged trailing context\n"), "{patch}");
        assert!(!patch.contains("unrelated local index bytes"));
        assert_eq!(
            comparison_bytes(result.before),
            COMPARISON_BEFORE.as_bytes()
        );
        assert_eq!(comparison_bytes(result.after), COMPARISON_AFTER.as_bytes());
        assert_eq!(repository_state(&repo).await, before_state);
    }

    #[tokio::test]
    async fn comparison_addition_deletion_and_rename_use_the_proven_path_on_each_side() {
        let (_dir, repo, base, head) = comparison_fixture().await;
        let before_state = repository_state(&repo).await;
        for (selected, old_path, new_path, before, after) in [
            (
                "added.txt",
                "added.txt",
                "added.txt",
                None,
                Some("entire added contents\n"),
            ),
            (
                "deleted.txt",
                "deleted.txt",
                "deleted.txt",
                Some("entire deleted contents\n"),
                None,
            ),
            (
                "new-name.txt",
                "old-name.txt",
                "new-name.txt",
                Some("entire before rename\n"),
                Some("entire after rename\n"),
            ),
            (
                "old-name.txt",
                "old-name.txt",
                "old-name.txt",
                None,
                Some("new file at renamed-away path\n"),
            ),
            (
                "pure-new.txt",
                "pure-old.txt",
                "pure-new.txt",
                Some("unchanged pure rename contents\n"),
                Some("unchanged pure rename contents\n"),
            ),
        ] {
            let mut change = comparison_change(old_path, new_path);
            change["new_file"] = serde_json::json!(before.is_none());
            change["deleted_file"] = serde_json::json!(after.is_none());
            let mut body = comparison_payload(&base, &head, change);
            if selected == "new-name.txt" {
                let mut new_at_old_path = comparison_change("old-name.txt", "old-name.txt");
                new_at_old_path["new_file"] = serde_json::json!(true);
                body["changes"]
                    .as_array_mut()
                    .unwrap()
                    .push(new_at_old_path);
            } else if selected == "old-name.txt" {
                body["changes"]
                    .as_array_mut()
                    .unwrap()
                    .push(comparison_change("old-name.txt", "new-name.txt"));
            }
            let result = snapshot_comparison_core(
                &AppState::default(),
                &request(&repo, &head),
                selected,
                Some(Provider::GitLab),
                || async { Ok(body.to_string()) },
            )
            .await
            .unwrap();

            assert_eq!(result.old_path.as_deref(), before.map(|_| old_path));
            assert_eq!(result.new_path.as_deref(), after.map(|_| new_path));
            if let (Some(before), Some(after)) = (before, after) {
                let patch = result
                    .patch
                    .as_deref()
                    .expect("a patch from both committed blobs");
                if before == after {
                    assert_eq!(patch, "", "pure renames need no invented hunk");
                } else {
                    for line in before.lines() {
                        assert!(patch.contains(&format!("-{line}\n")), "{patch}");
                    }
                    for line in after.lines() {
                        assert!(patch.contains(&format!("+{line}\n")), "{patch}");
                    }
                }
            } else {
                assert!(
                    result.patch.is_none(),
                    "one absent side needs no diff algorithm"
                );
            }
            match before {
                Some(bytes) => assert_eq!(comparison_bytes(result.before), bytes.as_bytes()),
                None => assert!(result.before.is_none()),
            }
            match after {
                Some(bytes) => assert_eq!(comparison_bytes(result.after), bytes.as_bytes()),
                None => assert!(result.after.is_none()),
            }
        }
        assert_eq!(repository_state(&repo).await, before_state);
    }

    #[tokio::test]
    async fn comparison_refuses_a_required_side_missing_from_its_commit() {
        let (_dir, repo, base, head) = comparison_fixture().await;
        let before_state = repository_state(&repo).await;
        for selected in ["added.txt", "deleted.txt", "absent.txt"] {
            let body = comparison_payload(&base, &head, comparison_change(selected, selected));
            let result = snapshot_comparison_core(
                &AppState::default(),
                &request(&repo, &head),
                selected,
                Some(Provider::GitLab),
                || async { Ok(body.to_string()) },
            )
            .await;
            assert!(result.is_err(), "invented an empty side for {selected}");
        }
        assert_eq!(repository_state(&repo).await, before_state);
    }

    #[test]
    fn comparison_refuses_a_mismatched_head_missing_metadata_and_uncertain_flags() {
        let base = "1".repeat(40);
        let head = "2".repeat(40);
        let good = comparison_payload(&base, &head, comparison_change("file.txt", "file.txt"));
        assert!(comparison_metadata(&good.to_string(), 7, &head, "file.txt").is_ok());
        let mut bad = Vec::new();
        for field in ["diff_refs", "changes", "iid"] {
            let mut body = good.clone();
            body.as_object_mut().unwrap().remove(field);
            bad.push(body);
        }
        for field in ["base_sha", "head_sha"] {
            let mut body = good.clone();
            body["diff_refs"].as_object_mut().unwrap().remove(field);
            bad.push(body);
        }
        for field in [
            "old_path",
            "new_path",
            "new_file",
            "deleted_file",
            "renamed_file",
        ] {
            let mut missing = good.clone();
            missing["changes"][0].as_object_mut().unwrap().remove(field);
            bad.push(missing);
            let mut null = good.clone();
            null["changes"][0][field] = serde_json::Value::Null;
            bad.push(null);
        }
        for invalid in [
            "HEAD",
            "",
            "../file.txt",
            "/file.txt",
            "dir/../file.txt",
            "nul\0.txt",
        ] {
            let mut body = good.clone();
            body["diff_refs"]["base_sha"] = serde_json::json!(invalid);
            bad.push(body);
        }
        let mut wrong_head = good.clone();
        wrong_head["diff_refs"]["head_sha"] = serde_json::json!(base);
        bad.push(wrong_head);
        let mut wrong_number = good.clone();
        wrong_number["iid"] = serde_json::json!(8);
        bad.push(wrong_number);
        let mut missing_selected = good.clone();
        missing_selected["changes"] = serde_json::json!([]);
        bad.push(missing_selected);
        let mut conflicting_flags = good.clone();
        conflicting_flags["changes"][0]["new_file"] = serde_json::json!(true);
        conflicting_flags["changes"][0]["deleted_file"] = serde_json::json!(true);
        bad.push(conflicting_flags);
        let mut unknown_flag = good.clone();
        unknown_flag["changes"][0]["renamed_file"] = serde_json::json!("false");
        bad.push(unknown_flag);
        let mut unexplained_rename = good.clone();
        unexplained_rename["changes"][0]["old_path"] = serde_json::json!("previous.txt");
        bad.push(unexplained_rename);
        let mut ambiguous = good.clone();
        ambiguous["changes"] = serde_json::json!([
            comparison_change("file.txt", "file.txt"),
            comparison_change("elsewhere.txt", "file.txt")
        ]);
        bad.push(ambiguous);
        for body in bad {
            assert!(
                comparison_metadata(&body.to_string(), 7, &head, "file.txt").is_err(),
                "unexpectedly trusted {body}"
            );
        }
        for invalid in [
            "",
            "../file.txt",
            "/file.txt",
            "./file.txt",
            "dir//file.txt",
            "nul\0.txt",
        ] {
            assert!(comparison_metadata(&good.to_string(), 7, &head, invalid).is_err());
            let body = comparison_payload(&base, &head, comparison_change(invalid, "file.txt"));
            assert!(comparison_metadata(&body.to_string(), 7, &head, "file.txt").is_err());
        }
    }

    #[tokio::test]
    async fn comparison_refuses_unsupported_providers_and_upstream_without_reading_metadata() {
        for provider in [None, Some(Provider::GitHub), Some(Provider::Bitbucket)] {
            let result = snapshot_comparison_core(
                &AppState::default(),
                &request("/not-opened", &"2".repeat(40)),
                "file.txt",
                provider,
                || async { panic!("an unsupported provider must not invoke glab") },
            )
            .await;
            assert!(matches!(result, Err(AppError::InvalidArgument(_))));
        }
        let upstream = SnapshotRequest::new(
            "/not-opened".into(),
            7,
            "2".repeat(40),
            Some("upstream".into()),
        )
        .unwrap();
        let result = snapshot_comparison_core(
            &AppState::default(),
            &upstream,
            "file.txt",
            Some(Provider::GitLab),
            || async { panic!("an unsupported lens must not invoke glab") },
        )
        .await;
        assert!(matches!(result, Err(AppError::InvalidArgument(_))));
    }

    #[tokio::test]
    async fn exact_commit_tree_ignores_the_current_index_and_replacements() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(&dir.path().join("repo")).await;
        let head = commit(&repo, "mr-only.txt").await;
        run(&repo, &["rm", "-q", "mr-only.txt"]).await;
        let current = commit(&repo, "local-only.txt").await;
        std::fs::write(Path::new(&repo).join("staged-only.txt"), "staged\n").unwrap();
        run(&repo, &["add", "staged-only.txt"]).await;
        run(&repo, &["replace", &head, &current]).await;

        let rows = snapshot_files_core(
            &AppState::default(),
            &request(&repo, &head),
            unavailable_source,
        )
        .await
        .unwrap();

        assert_eq!(paths(rows), ["mr-only.txt"]);
        assert_eq!(run(&repo, &["rev-parse", "HEAD"]).await, current);
        assert!(Path::new(&repo).join("staged-only.txt").exists());
    }

    #[tokio::test]
    async fn a_hex_named_ref_cannot_impersonate_the_requested_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(&dir.path().join("repo")).await;
        commit(&repo, "local.txt").await;
        let missing = "f".repeat(40);
        run(&repo, &["branch", &missing]).await;

        let result = snapshot_files_core(
            &AppState::default(),
            &request(&repo, &missing),
            unavailable_source,
        )
        .await;

        assert!(matches!(result, Err(AppError::InvalidArgument(_))));
    }

    #[tokio::test]
    async fn a_loose_hex_named_pseudoref_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(&dir.path().join("repo")).await;
        let head = commit(&repo, "mr.txt").await;
        let other = commit(&repo, "local.txt").await;
        std::fs::write(
            Path::new(&repo).join(".git").join(&head),
            format!("{other}\n"),
        )
        .unwrap();

        let result = snapshot_files_core(
            &AppState::default(),
            &request(&repo, &head),
            unavailable_source,
        )
        .await;

        assert!(matches!(result, Err(AppError::InvalidArgument(_))));
    }

    #[tokio::test]
    async fn a_blob_oid_is_refused_instead_of_being_treated_as_a_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(&dir.path().join("repo")).await;
        commit(&repo, "file.txt").await;
        let blob = run(&repo, &["rev-parse", "HEAD:file.txt"]).await;

        let result = snapshot_files_core(
            &AppState::default(),
            &request(&repo, &blob),
            unavailable_source,
        )
        .await;

        assert!(matches!(result, Err(AppError::InvalidArgument(_))));
    }

    #[tokio::test]
    async fn snapshot_source_matches_the_raw_tree_despite_commit_and_blob_replacements() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(&dir.path().join("repo")).await;
        let head = commit(&repo, "file.txt").await;
        let old_blob = run(&repo, &["rev-parse", "HEAD:file.txt"]).await;
        std::fs::write(
            Path::new(&repo).join("file.txt"),
            "different local version\n",
        )
        .unwrap();
        run(&repo, &["add", "file.txt"]).await;
        run(&repo, &["commit", "-qm", "local version"]).await;
        let current = run(&repo, &["rev-parse", "HEAD"]).await;
        let new_blob = run(&repo, &["rev-parse", "HEAD:file.txt"]).await;
        run(&repo, &["replace", &head, &current]).await;
        run(&repo, &["replace", &old_blob, &new_blob]).await;
        let rows = snapshot_files_core(
            &AppState::default(),
            &request(&repo, &head),
            unavailable_source,
        )
        .await
        .unwrap();

        let file = source_file(&repo, &head, "file.txt")
            .await
            .unwrap()
            .expect("snapshot file bytes");

        assert_eq!(paths(rows), ["file.txt"]);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(file.base64.unwrap())
                .unwrap(),
            b"file.txt\n"
        );
        let ordinary =
            crate::git::diff::git_file_base64(repo, Some(head), "file.txt".into(), Some(true))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(ordinary.base64.unwrap())
                .unwrap(),
            b"different local version\n"
        );
    }

    #[tokio::test]
    async fn snapshot_source_rejects_invalid_paths_and_unavailable_objects() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(&dir.path().join("repo")).await;
        let head = commit(&repo, "file.txt").await;
        for path in [
            "",
            "../file.txt",
            "/file.txt",
            "./file.txt",
            "dir/../file.txt",
            "nul\0.txt",
        ] {
            assert!(
                matches!(
                    source_file(&repo, &head, path).await,
                    Err(AppError::InvalidArgument(_))
                ),
                "{path:?}"
            );
        }
        assert!(source_file(&repo, "HEAD", "file.txt").await.is_err());
        assert!(source_file(&repo, &"e".repeat(40), "file.txt")
            .await
            .is_err());
        assert!(source_file(&repo, &head, "absent.txt").await.is_err());
        let blob = run(&repo, &["rev-parse", "HEAD:file.txt"]).await;
        assert!(source_file(&repo, &blob, "file.txt").await.is_err());
        let current = commit(&repo, "local.txt").await;
        std::fs::write(
            Path::new(&repo).join(".git").join(&head),
            format!("{current}\n"),
        )
        .unwrap();
        assert!(matches!(
            source_file(&repo, &head, "file.txt").await,
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[tokio::test]
    async fn oversized_snapshot_source_returns_a_size_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(&dir.path().join("repo")).await;
        let file = std::fs::File::create(Path::new(&repo).join("large.txt")).unwrap();
        file.set_len(20_000_001).unwrap();
        run(&repo, &["add", "large.txt"]).await;
        run(&repo, &["commit", "-qm", "large source"]).await;
        let head = run(&repo, &["rev-parse", "HEAD"]).await;

        let file = source_file(&repo, &head, "large.txt")
            .await
            .unwrap()
            .expect("size refusal");

        assert!(file.too_large);
        assert_eq!(file.size, Some(20_000_001));
        assert!(file.base64.is_none());
    }

    struct RemoteFixture {
        _dir: tempfile::TempDir,
        repo: String,
        head: String,
        newer: String,
    }

    struct PartialFixture {
        _dir: tempfile::TempDir,
        repo: String,
        remote: String,
        head: String,
        root_tree: String,
        old_tree: String,
        blob: String,
        unselected_blob: String,
    }

    async fn partial_fixture(filter: &str) -> PartialFixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let seed = repository(&dir.path().join("seed")).await;
        commit(&seed, "old-history.txt").await;
        let old_tree = run(&seed, &["rev-parse", "HEAD^{tree}"]).await;
        run(&seed, &["rm", "-q", "old-history.txt"]).await;
        std::fs::create_dir_all(Path::new(&seed).join("nested/deeper")).unwrap();
        std::fs::write(
            Path::new(&seed).join("nested/deeper/source.txt"),
            "exact partial source\n",
        )
        .unwrap();
        let head = commit(&seed, "root.txt").await;
        let root_tree = run(&seed, &["rev-parse", "HEAD^{tree}"]).await;
        let blob = run(&seed, &["rev-parse", "HEAD:nested/deeper/source.txt"]).await;
        let unselected_blob = run(&seed, &["rev-parse", "HEAD:root.txt"]).await;
        let remote_path = dir.path().join("remote.git");
        let remote = remote_path.to_string_lossy().into_owned();
        let repo = dir.path().join("partial").to_string_lossy().into_owned();
        run(&root, &["clone", "-q", "--bare", &seed, &remote]).await;
        run(&remote, &["config", "uploadpack.allowFilter", "true"]).await;
        run(
            &remote,
            &["config", "uploadpack.allowAnySHA1InWant", "true"],
        )
        .await;
        let spelled = remote_path.to_string_lossy().replace('\\', "/");
        let remote = if spelled.starts_with('/') {
            format!("file://{spelled}")
        } else {
            format!("file:///{spelled}")
        };
        let filter_arg = format!("--filter={filter}");
        run(
            &root,
            &[
                "clone",
                "-q",
                "--no-checkout",
                "--depth=1",
                &filter_arg,
                &remote,
                &repo,
            ],
        )
        .await;
        assert_eq!(
            run(&repo, &["config", "--get", "remote.origin.promisor"]).await,
            "true"
        );
        std::fs::write(
            Path::new(&repo).join(".git/FETCH_HEAD"),
            "kept partial marker\n",
        )
        .unwrap();
        PartialFixture {
            _dir: dir,
            repo,
            remote,
            head,
            root_tree,
            old_tree,
            blob,
            unselected_blob,
        }
    }

    async fn object_local(repo: &str, oid: &str) -> bool {
        run(repo, &["rev-parse", &format!("--disambiguate={oid}")]).await == oid
    }

    #[derive(Debug, PartialEq, Eq)]
    struct RepositoryState {
        config: Vec<u8>,
        head: Vec<u8>,
        fetch_head: Vec<u8>,
        index: Option<Vec<u8>>,
        shallow: Option<Vec<u8>>,
        refs: String,
    }

    async fn repository_state(repo: &str) -> RepositoryState {
        let git = Path::new(repo).join(".git");
        RepositoryState {
            config: std::fs::read(git.join("config")).unwrap(),
            head: std::fs::read(git.join("HEAD")).unwrap(),
            fetch_head: std::fs::read(git.join("FETCH_HEAD")).unwrap(),
            index: std::fs::read(git.join("index")).ok(),
            shallow: std::fs::read(git.join("shallow")).ok(),
            refs: refs(repo).await,
        }
    }

    #[tokio::test]
    async fn partial_clone_tree_hydrates_missing_root_and_nested_trees_without_blobs_or_history() {
        for filter in ["tree:0", "tree:1"] {
            let fx = partial_fixture(filter).await;
            assert!(object_local(&fx.repo, &fx.head).await);
            assert_eq!(
                object_local(&fx.repo, &fx.root_tree).await,
                filter == "tree:1"
            );
            assert!(!object_local(&fx.repo, &fx.blob).await);
            let before = repository_state(&fx.repo).await;

            let rows = snapshot_files_core(
                &AppState::default(),
                &request(&fx.repo, &fx.head),
                unavailable_source,
            )
            .await
            .unwrap();

            assert_eq!(paths(rows), ["nested/deeper/source.txt", "root.txt"]);
            assert!(!object_local(&fx.repo, &fx.blob).await);
            assert!(!object_local(&fx.repo, &fx.unselected_blob).await);
            assert!(!object_local(&fx.repo, &fx.old_tree).await);
            assert_eq!(repository_state(&fx.repo).await, before);
        }
    }

    #[tokio::test]
    async fn partial_clone_source_hydrates_only_selected_blob_from_the_upstream_lens() {
        let fx = partial_fixture("blob:none").await;
        run(&fx.repo, &["remote", "add", "upstream", &fx.remote]).await;
        run(
            &fx.repo,
            &[
                "remote",
                "set-url",
                "origin",
                "file:///missing-snapshot-origin.git",
            ],
        )
        .await;
        assert!(!object_local(&fx.repo, &fx.blob).await);
        assert!(!object_local(&fx.repo, &fx.unselected_blob).await);
        let before = repository_state(&fx.repo).await;

        let file = snapshot_file_core(
            &AppState::default(),
            &fx.repo,
            &fx.head,
            "nested/deeper/source.txt",
            "upstream",
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(file.base64.unwrap())
                .unwrap(),
            b"exact partial source\n"
        );
        assert!(object_local(&fx.repo, &fx.blob).await);
        assert!(!object_local(&fx.repo, &fx.unselected_blob).await);
        assert!(!object_local(&fx.repo, &fx.old_tree).await);
        assert_eq!(repository_state(&fx.repo).await, before);
    }

    async fn remote_fixture() -> RemoteFixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let seed = repository(&dir.path().join("seed")).await;
        let remote = dir.path().join("remote.git").to_string_lossy().into_owned();
        let repo = dir.path().join("repo").to_string_lossy().into_owned();
        commit(&seed, "base.txt").await;
        run(&root, &["clone", "-q", "--bare", &seed, &remote]).await;
        run(&root, &["clone", "-q", &remote, &repo]).await;
        run(&seed, &["switch", "-q", "-c", "feature"]).await;
        let head = commit(&seed, "mr-only.txt").await;
        let newer = commit(&seed, "newer-only.txt").await;
        run(
            &seed,
            &["push", "-q", &remote, "HEAD:refs/merge-requests/7/head"],
        )
        .await;
        run(&seed, &["push", "-q", &remote, "HEAD:refs/tags/remote-tag"]).await;
        run(&repo, &["config", "fetch.prune", "true"]).await;
        run(&repo, &["config", "fetch.pruneTags", "true"]).await;
        run(
            &repo,
            &[
                "config",
                "--add",
                "remote.origin.fetch",
                "+refs/merge-requests/*/head:refs/remotes/origin/mr/*",
            ],
        )
        .await;
        run(&repo, &["update-ref", "refs/remotes/origin/stale", "HEAD"]).await;
        run(&repo, &["tag", "retained-tag"]).await;
        std::fs::write(
            Path::new(&repo).join(".git/FETCH_HEAD"),
            "kept fetch marker\n",
        )
        .unwrap();
        RemoteFixture {
            _dir: dir,
            repo,
            head,
            newer,
        }
    }

    async fn refs(repo: &str) -> String {
        run(repo, &["for-each-ref", "--format=%(refname) %(objectname)"]).await
    }

    #[tokio::test]
    async fn missing_commit_fetches_exact_snapshot_without_changing_refs_or_checkout() {
        let fx = remote_fixture().await;
        let before_refs = refs(&fx.repo).await;
        let before_head = run(&fx.repo, &["rev-parse", "HEAD"]).await;
        let before_branch = run(&fx.repo, &["symbolic-ref", "HEAD"]).await;
        let before_config = std::fs::read(Path::new(&fx.repo).join(".git/config")).unwrap();
        let absent = run_git_raw(
            Some(&fx.repo),
            &["cat-file", "-e", &fx.head],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_ne!(absent.code, 0);

        let rows = snapshot_files_core(
            &AppState::default(),
            &request(&fx.repo, &fx.head),
            unavailable_source,
        )
        .await
        .unwrap();

        assert_eq!(paths(rows), ["base.txt", "mr-only.txt"]);
        assert_eq!(refs(&fx.repo).await, before_refs);
        assert_eq!(run(&fx.repo, &["rev-parse", "HEAD"]).await, before_head);
        assert_eq!(
            run(&fx.repo, &["symbolic-ref", "HEAD"]).await,
            before_branch
        );
        assert_eq!(
            std::fs::read(Path::new(&fx.repo).join(".git/config")).unwrap(),
            before_config
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&fx.repo).join(".git/FETCH_HEAD")).unwrap(),
            "kept fetch marker\n"
        );
    }

    #[tokio::test]
    async fn fallback_fetch_refuses_a_different_mr_tip_instead_of_listing_it() {
        let fx = remote_fixture().await;
        let missing = "f".repeat(40);
        let before_refs = refs(&fx.repo).await;
        let source = PrCheckoutSource {
            head: "feature".into(),
            fork: true,
            same_repo: false,
            owner: None,
            from: FetchFrom::Remote("origin"),
            source_ref: SourceRef::MergeRequestHead(7),
        };

        let result =
            snapshot_files_core(&AppState::default(), &request(&fx.repo, &missing), || {
                std::future::ready(Ok(source))
            })
            .await;

        assert!(matches!(result, Err(AppError::InvalidArgument(_))));
        let fetched = run_git_raw(
            Some(&fx.repo),
            &["cat-file", "-e", &fx.newer],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_eq!(fetched.code, 0, "the provider ref fallback must have run");
        assert_eq!(refs(&fx.repo).await, before_refs);
        assert_eq!(
            std::fs::read_to_string(Path::new(&fx.repo).join(".git/FETCH_HEAD")).unwrap(),
            "kept fetch marker\n"
        );
    }

    #[test]
    fn invalid_snapshot_requests_are_rejected() {
        for sha in ["", "HEAD", "main", "abc123", "--help", &"g".repeat(40)] {
            assert!(SnapshotRequest::new("repo".into(), 7, sha.into(), None).is_err());
        }
        assert!(SnapshotRequest::new("repo".into(), 0, "a".repeat(40), None).is_err());
        assert!(
            SnapshotRequest::new("repo".into(), 7, "a".repeat(40), Some("other".into())).is_err()
        );
        assert!(SnapshotRequest::new("repo".into(), 7, "A".repeat(40), None).is_ok());
        assert!(SnapshotRequest::new("repo".into(), 7, "a".repeat(64), None).is_ok());
    }

    #[test]
    fn upstream_is_reserved_for_the_github_context() {
        assert!(validate_forge_lens(Some(Provider::GitLab), "upstream").is_err());
        assert!(validate_forge_lens(Some(Provider::Bitbucket), "upstream").is_err());
        assert!(validate_forge_lens(None, "upstream").is_ok());
        assert!(validate_forge_lens(Some(Provider::GitHub), "upstream").is_ok());
        assert!(validate_forge_lens(Some(Provider::GitLab), "origin").is_ok());
        let req = SnapshotRequest::new("repo".into(), 7, "a".repeat(40), Some("upstream".into()))
            .unwrap();
        assert_eq!(req.remote, "upstream");
    }

    #[test]
    fn listing_splits_nul_bytes_before_decoding_each_path() {
        let rows =
            snapshot_paths(b"folder/a\n\tb.ts\0bad-\xff.txt\0valid-\xef\xbf\xbd.txt\0").unwrap();
        assert_eq!(
            rows,
            [
                PathListingEntry {
                    path: "folder/a\n\tb.ts".into(),
                    undecodable: false
                },
                PathListingEntry {
                    path: "bad-\u{fffd}.txt".into(),
                    undecodable: true
                },
                PathListingEntry {
                    path: "valid-\u{fffd}.txt".into(),
                    undecodable: false
                },
            ]
        );
        assert!(snapshot_paths(b"").unwrap().is_empty());
        assert!(snapshot_paths(b"unfinished").is_err());
    }
}
