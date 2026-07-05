//! Minimal AST-aware structural search and rewrite N-API exports.

use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering as AtomicOrdering},
    },
    time::{Duration, Instant},
};

use ast_grep_core::{MatchStrictness, matcher::Pattern, source::Edit, tree_sitter::LanguageExt};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::{DirEntry, WalkBuilder};
use napi::{Env, Error, Result, Task, bindgen_prelude::*};
use napi_derive::napi;
use pi_ast::{
    SupportLang,
    ops::{self as shared_ops},
};

const DEFAULT_FIND_LIMIT: u32 = 50;

pub struct Blocking<T>
where
    T: Send + 'static,
{
    cancel_token: CancelToken,
    work: Option<Box<dyn FnOnce(CancelToken) -> Result<T> + Send>>,
}

impl<T> Task for Blocking<T>
where
    T: ToNapiValue + Send + 'static + TypeName,
{
    type JsValue = T;
    type Output = T;

    fn compute(&mut self) -> Result<Self::Output> {
        let work = self
            .work
            .take()
            .ok_or_else(|| Error::from_reason("native task already consumed"))?;
        work(self.cancel_token.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

type Promise<T> = AsyncTask<Blocking<T>>;

fn blocking<T, F>(cancel_token: CancelToken, work: F) -> Promise<T>
where
    F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
    T: ToNapiValue + TypeName + Send + 'static,
{
    AsyncTask::new(Blocking {
        cancel_token,
        work: Some(Box::new(work)),
    })
}

/// ast-grep pattern strictness (controls how patterns match syntax).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum AstMatchStrictness {
    #[napi(value = "cst")]
    Cst,
    #[napi(value = "smart")]
    Smart,
    #[napi(value = "ast")]
    Ast,
    #[napi(value = "relaxed")]
    Relaxed,
    #[napi(value = "signature")]
    Signature,
    #[napi(value = "template")]
    Template,
}

impl From<AstMatchStrictness> for MatchStrictness {
    fn from(value: AstMatchStrictness) -> Self {
        match value {
            AstMatchStrictness::Cst => Self::Cst,
            AstMatchStrictness::Smart => Self::Smart,
            AstMatchStrictness::Ast => Self::Ast,
            AstMatchStrictness::Relaxed => Self::Relaxed,
            AstMatchStrictness::Signature => Self::Signature,
            AstMatchStrictness::Template => Self::Template,
        }
    }
}

fn resolve_strictness(value: Option<AstMatchStrictness>) -> MatchStrictness {
    value.map_or(MatchStrictness::Smart, Into::into)
}

#[napi(object)]
pub struct AstFindOptions<'env> {
    pub patterns: Option<Vec<String>>,
    pub lang: Option<String>,
    pub path: Option<String>,
    pub glob: Option<String>,
    pub selector: Option<String>,
    pub strictness: Option<AstMatchStrictness>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub include_meta: Option<bool>,
    pub context: Option<u32>,
    pub signal: Option<Unknown<'env>>,
    pub timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct AstFindMatch {
    pub path: String,
    pub text: String,
    pub byte_start: u32,
    pub byte_end: u32,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub meta_variables: Option<HashMap<String, String>>,
}

#[napi(object)]
pub struct AstFindResult {
    pub matches: Vec<AstFindMatch>,
    pub total_matches: u32,
    pub files_with_matches: u32,
    pub files_searched: u32,
    pub limit_reached: bool,
    pub parse_errors: Option<Vec<String>>,
}

#[napi(object)]
pub struct AstMatchOptions<'env> {
    pub source: String,
    pub lang: String,
    pub patterns: Vec<String>,
    pub selector: Option<String>,
    pub strictness: Option<AstMatchStrictness>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub include_meta: Option<bool>,
    pub signal: Option<Unknown<'env>>,
    pub timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct AstMatchResult {
    pub matches: Vec<AstFindMatch>,
    pub total_matches: u32,
    pub limit_reached: bool,
    pub parse_errors: Option<Vec<String>>,
}

#[napi(object)]
pub struct AstReplaceOptions<'env> {
    pub rewrites: Option<HashMap<String, String>>,
    pub lang: Option<String>,
    pub path: Option<String>,
    pub glob: Option<String>,
    pub selector: Option<String>,
    pub strictness: Option<AstMatchStrictness>,
    pub dry_run: Option<bool>,
    pub max_replacements: Option<u32>,
    pub max_files: Option<u32>,
    pub fail_on_parse_error: Option<bool>,
    pub signal: Option<Unknown<'env>>,
    pub timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct AstReplaceChange {
    pub path: String,
    pub before: String,
    pub after: String,
    pub byte_start: u32,
    pub byte_end: u32,
    pub deleted_length: u32,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[napi(object)]
pub struct AstReplaceFileChange {
    pub path: String,
    pub count: u32,
}

#[napi(object)]
pub struct AstReplaceResult {
    pub changes: Vec<AstReplaceChange>,
    pub file_changes: Vec<AstReplaceFileChange>,
    pub total_replacements: u32,
    pub files_touched: u32,
    pub files_searched: u32,
    pub applied: bool,
    pub limit_reached: bool,
    pub parse_errors: Option<Vec<String>>,
}

#[derive(Clone, Eq, PartialEq)]
struct AstFindOrderKey {
    path: String,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
    byte_start: u32,
    byte_end: u32,
    sequence: u64,
}

impl Ord for AstFindOrderKey {
    fn cmp(&self, other: &Self) -> Ordering {
        self.path
            .cmp(&other.path)
            .then(self.start_line.cmp(&other.start_line))
            .then(self.start_column.cmp(&other.start_column))
            .then(self.end_line.cmp(&other.end_line))
            .then(self.end_column.cmp(&other.end_column))
            .then(self.byte_start.cmp(&other.byte_start))
            .then(self.byte_end.cmp(&other.byte_end))
            .then(self.sequence.cmp(&other.sequence))
    }
}

impl PartialOrd for AstFindOrderKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Eq, PartialEq)]
struct RetainedAstFindMatch {
    key: AstFindOrderKey,
    text: String,
    meta_variables: Option<HashMap<String, String>>,
}

impl Ord for RetainedAstFindMatch {
    fn cmp(&self, other: &Self) -> Ordering {
        self.key.cmp(&other.key)
    }
}

impl PartialOrd for RetainedAstFindMatch {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

struct FileCandidate {
    absolute_path: PathBuf,
    display_path: String,
}

struct PendingFileChange {
    change: AstReplaceChange,
    edit: Edit<String>,
}

struct PendingWrite {
    absolute_path: PathBuf,
    output: String,
}

#[derive(Clone)]
struct CancelToken {
    deadline: Option<Instant>,
    aborted: Arc<AtomicBool>,
}

impl CancelToken {
    fn new(timeout_ms: Option<u32>, signal: Option<Unknown<'_>>) -> Self {
        let aborted = Arc::new(AtomicBool::new(false));
        if let Some(signal) = signal.and_then(|value| AbortSignal::from_unknown(value).ok()) {
            let abort_flag = Arc::clone(&aborted);
            signal.on_abort(move || abort_flag.store(true, AtomicOrdering::SeqCst));
        }
        Self {
            deadline: timeout_ms.map(|ms| Instant::now() + Duration::from_millis(u64::from(ms))),
            aborted,
        }
    }

    fn heartbeat(&self) -> Result<()> {
        if self.aborted.load(AtomicOrdering::SeqCst) {
            return Err(Error::from_reason("Operation cancelled"));
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(Error::from_reason("Operation timed out"));
        }
        Ok(())
    }
}

fn to_u32(value: usize) -> u32 {
    value.min(u32::MAX as usize) as u32
}

fn to_napi_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}

fn resolve_supported_lang(value: &str) -> Result<SupportLang> {
    shared_ops::resolve_supported_lang(value).map_err(to_napi_error)
}

fn resolve_language(lang: Option<&str>, file_path: &Path) -> Result<SupportLang> {
    shared_ops::resolve_language(lang, file_path).map_err(to_napi_error)
}

fn is_supported_file(file_path: &Path, explicit_lang: Option<&str>) -> bool {
    shared_ops::is_supported_file(file_path, explicit_lang)
}

fn compile_pattern(
    pattern: &str,
    selector: Option<&str>,
    strictness: &MatchStrictness,
    lang: SupportLang,
) -> Result<Pattern> {
    shared_ops::compile_pattern(pattern, selector, strictness, lang).map_err(to_napi_error)
}

fn apply_edits(content: &str, edits: &[Edit<String>]) -> Result<String> {
    shared_ops::apply_edits(content, edits).map_err(to_napi_error)
}

fn normalize_search_path(path: Option<String>) -> Result<PathBuf> {
    let raw = path.unwrap_or_else(|| ".".to_string());
    let candidate = PathBuf::from(raw.trim());
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        std::env::current_dir()
            .map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?
            .join(candidate)
    };
    Ok(std::fs::canonicalize(&absolute).unwrap_or(absolute))
}

fn build_glob_pattern(glob: &str) -> String {
    let pattern = glob.replace('\\', "/");
    let opens = pattern.chars().filter(|&ch| ch == '{').count();
    let closes = pattern.chars().filter(|&ch| ch == '}').count();
    if opens <= closes {
        pattern
    } else {
        let mut fixed = pattern;
        for _ in 0..(opens - closes) {
            fixed.push('}');
        }
        fixed
    }
}

fn compile_glob(glob: Option<&str>) -> Result<Option<GlobSet>> {
    let Some(glob) = glob.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let mut builder = GlobSetBuilder::new();
    let parsed = GlobBuilder::new(&build_glob_pattern(glob))
        .literal_separator(true)
        .build()
        .map_err(|err| Error::from_reason(format!("Invalid glob pattern: {err}")))?;
    builder.add(parsed);
    builder
        .build()
        .map(Some)
        .map_err(|err| Error::from_reason(format!("Failed to build glob matcher: {err}")))
}

fn should_skip_dir(entry: &DirEntry, mentions_node_modules: bool) -> bool {
    let name = entry.file_name().to_string_lossy();
    name == ".git" || (!mentions_node_modules && name == "node_modules")
}

fn collect_candidates(
    path: Option<String>,
    glob: Option<&str>,
    ct: &CancelToken,
) -> Result<Vec<FileCandidate>> {
    ct.heartbeat()?;
    let search_path = normalize_search_path(path)?;
    ct.heartbeat()?;
    let metadata = std::fs::metadata(&search_path)
        .map_err(|err| Error::from_reason(format!("Path not found: {err}")))?;

    if metadata.is_file() {
        let display_path = search_path
            .file_name()
            .and_then(|name| name.to_str())
            .map_or_else(
                || search_path.to_string_lossy().into_owned(),
                ToOwned::to_owned,
            );
        return Ok(vec![FileCandidate {
            absolute_path: search_path,
            display_path,
        }]);
    }

    if !metadata.is_dir() {
        return Err(Error::from_reason(format!(
            "Search path must be a file or directory: {}",
            search_path.display()
        )));
    }

    let glob_set = compile_glob(glob)?;
    let mentions_node_modules = glob.is_some_and(|value| value.contains("node_modules"));
    let mut builder = WalkBuilder::new(&search_path);
    builder
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .follow_links(false)
        .filter_entry(move |entry| !should_skip_dir(entry, mentions_node_modules));

    let mut files = Vec::new();
    for entry in builder.build() {
        ct.heartbeat()?;
        let entry = entry.map_err(to_napi_error)?;
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            continue;
        }
        let absolute_path = entry.into_path();
        let display_path = absolute_path
            .strip_prefix(&search_path)
            .unwrap_or(&absolute_path)
            .to_string_lossy()
            .replace('\\', "/");
        if glob_set
            .as_ref()
            .is_none_or(|set| set.is_match(&display_path))
        {
            files.push(FileCandidate {
                absolute_path,
                display_path,
            });
        }
    }

    files.sort_by(|left, right| left.display_path.cmp(&right.display_path));
    Ok(files)
}

fn normalize_pattern_list(patterns: Option<Vec<String>>) -> Result<Vec<String>> {
    let mut normalized = Vec::new();
    let mut seen = BTreeSet::new();
    for raw in patterns.unwrap_or_default() {
        let pattern = raw.trim();
        if pattern.is_empty() || seen.contains(pattern) {
            continue;
        }
        let owned = if pattern.len() == raw.len() {
            raw
        } else {
            pattern.to_string()
        };
        seen.insert(owned.clone());
        normalized.push(owned);
    }
    if normalized.is_empty() {
        return Err(Error::from_reason(
            "`patterns` is required and must include at least one non-empty pattern",
        ));
    }
    Ok(normalized)
}

fn normalize_rewrite_map(
    rewrites: Option<HashMap<String, String>>,
) -> Result<Vec<(String, String)>> {
    let mut normalized = Vec::new();
    for (pattern, rewrite) in rewrites.unwrap_or_default() {
        if pattern.is_empty() {
            return Err(Error::from_reason(
                "`rewrites` keys must be non-empty pattern strings",
            ));
        }
        normalized.push((pattern, rewrite));
    }
    if normalized.is_empty() {
        return Err(Error::from_reason(
            "`rewrites` is required and must include at least one pattern->rewrite mapping",
        ));
    }
    normalized.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(normalized)
}

fn retained_find_capacity(offset: u32, limit: u32) -> usize {
    usize::try_from(offset.saturating_add(limit).saturating_add(1)).unwrap_or(usize::MAX)
}

fn should_retain_match(
    retained: &BinaryHeap<RetainedAstFindMatch>,
    capacity: usize,
    key: &AstFindOrderKey,
) -> bool {
    retained.len() < capacity
        || retained
            .peek()
            .is_some_and(|worst_retained| key.cmp(&worst_retained.key).is_lt())
}

fn retain_bounded_match(
    retained: &mut BinaryHeap<RetainedAstFindMatch>,
    capacity: usize,
    candidate: RetainedAstFindMatch,
) {
    if retained.len() < capacity {
        retained.push(candidate);
        return;
    }
    if let Some(mut worst_retained) = retained.peek_mut()
        && candidate.key.cmp(&worst_retained.key).is_lt()
    {
        *worst_retained = candidate;
    }
}

fn page_retained_matches(
    retained: BinaryHeap<RetainedAstFindMatch>,
    offset: u32,
    limit: u32,
) -> (Vec<RetainedAstFindMatch>, bool) {
    let mut retained_matches = retained.into_vec();
    retained_matches.sort_by(|left, right| left.key.cmp(&right.key));
    let offset = usize::try_from(offset).unwrap_or(usize::MAX);
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let limit_reached = retained_matches.len().saturating_sub(offset) > limit;
    let matches = retained_matches
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect();
    (matches, limit_reached)
}

fn retained_to_find_match(retained: RetainedAstFindMatch) -> AstFindMatch {
    let RetainedAstFindMatch {
        key,
        text,
        meta_variables,
    } = retained;
    AstFindMatch {
        path: key.path,
        text,
        byte_start: key.byte_start,
        byte_end: key.byte_end,
        start_line: key.start_line,
        start_column: key.start_column,
        end_line: key.end_line,
        end_column: key.end_column,
        meta_variables,
    }
}

struct CompiledFindPattern {
    pattern: String,
    compiled_by_lang: HashMap<String, Pattern>,
    compile_errors_by_lang: HashMap<String, String>,
}

struct ResolvedCandidate {
    candidate: FileCandidate,
    language: Option<SupportLang>,
    language_error: Option<String>,
}

fn resolve_candidates_for_find(
    candidates: Vec<FileCandidate>,
    lang: Option<&str>,
    ct: &CancelToken,
) -> Result<(Vec<ResolvedCandidate>, HashMap<String, SupportLang>)> {
    let mut resolved = Vec::with_capacity(candidates.len());
    let mut languages = HashMap::new();

    for candidate in candidates {
        ct.heartbeat()?;
        match resolve_language(lang, &candidate.absolute_path) {
            Ok(language) => {
                let key = language.canonical_name().to_string();
                languages.entry(key).or_insert(language);
                resolved.push(ResolvedCandidate {
                    candidate,
                    language: Some(language),
                    language_error: None,
                });
            }
            Err(err) => {
                resolved.push(ResolvedCandidate {
                    candidate,
                    language: None,
                    language_error: Some(err.to_string()),
                });
            }
        }
    }

    Ok((resolved, languages))
}

fn compile_find_patterns(
    patterns: &[String],
    languages: &HashMap<String, SupportLang>,
    selector: Option<&str>,
    strictness: &MatchStrictness,
    ct: &CancelToken,
) -> Result<Vec<CompiledFindPattern>> {
    let mut compiled = Vec::with_capacity(patterns.len());

    for pattern in patterns {
        ct.heartbeat()?;
        let mut compiled_by_lang = HashMap::with_capacity(languages.len());
        let mut compile_errors_by_lang = HashMap::new();

        for (lang_key, &language) in languages {
            ct.heartbeat()?;
            match compile_pattern(pattern, selector, strictness, language) {
                Ok(compiled_pattern) => {
                    compiled_by_lang.insert(lang_key.clone(), compiled_pattern);
                }
                Err(err) => {
                    compile_errors_by_lang.insert(lang_key.clone(), err.to_string());
                }
            }
        }

        compiled.push(CompiledFindPattern {
            pattern: pattern.clone(),
            compiled_by_lang,
            compile_errors_by_lang,
        });
    }

    Ok(compiled)
}

#[napi]
pub fn ast_grep(options: AstFindOptions<'_>) -> Promise<AstFindResult> {
    let AstFindOptions {
        patterns,
        lang,
        path,
        glob,
        selector,
        strictness,
        limit,
        offset,
        include_meta,
        context: _,
        signal,
        timeout_ms,
    } = options;

    let cancel_token = CancelToken::new(timeout_ms, signal);
    let normalized_limit = limit.unwrap_or(DEFAULT_FIND_LIMIT).max(1);
    let normalized_offset = offset.unwrap_or(0);

    blocking(cancel_token, move |ct| {
        ct.heartbeat()?;
        let patterns = normalize_pattern_list(patterns)?;
        let strictness = resolve_strictness(strictness);
        let include_meta = include_meta.unwrap_or(false);
        let lang_str = lang
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let candidates: Vec<_> = collect_candidates(path, glob.as_deref(), &ct)?
            .into_iter()
            .filter(|candidate| is_supported_file(&candidate.absolute_path, lang_str))
            .collect();

        let (resolved_candidates, languages) =
            resolve_candidates_for_find(candidates, lang_str, &ct)?;
        let compiled_patterns =
            compile_find_patterns(&patterns, &languages, selector.as_deref(), &strictness, &ct)?;
        let files_searched = to_u32(resolved_candidates.len());

        let retained_capacity = retained_find_capacity(normalized_offset, normalized_limit);
        let mut retained_matches = BinaryHeap::new();
        let mut parse_errors = Vec::new();
        let mut total_matches = 0u32;
        let mut match_sequence = 0u64;
        let mut files_with_matches = BTreeSet::new();

        for resolved in resolved_candidates {
            ct.heartbeat()?;
            let ResolvedCandidate {
                candidate,
                language,
                language_error,
            } = resolved;

            if let Some(error) = language_error.as_deref() {
                for compiled in &compiled_patterns {
                    parse_errors.push(format!(
                        "{}: {}: {error}",
                        compiled.pattern, candidate.display_path
                    ));
                }
                continue;
            }

            let Some(language) = language else { continue };
            let lang_key = language.canonical_name();
            let source = match std::fs::read_to_string(&candidate.absolute_path) {
                Ok(source) => source,
                Err(err) => {
                    for compiled in &compiled_patterns {
                        parse_errors.push(format!(
                            "{}: {}: {err}",
                            compiled.pattern, candidate.display_path
                        ));
                    }
                    continue;
                }
            };

            let mut runnable_patterns = Vec::new();
            for compiled in &compiled_patterns {
                ct.heartbeat()?;
                if let Some(error) = compiled.compile_errors_by_lang.get(lang_key) {
                    parse_errors.push(format!(
                        "{}: {}: {error}",
                        compiled.pattern, candidate.display_path
                    ));
                    continue;
                }
                if let Some(pattern) = compiled.compiled_by_lang.get(lang_key) {
                    runnable_patterns.push(pattern);
                }
            }
            if runnable_patterns.is_empty() {
                continue;
            }

            let ast = language.ast_grep(source);
            if ast.root().dfs().any(|node| node.is_error()) {
                parse_errors.push(format!(
                    "{}: parse error (syntax tree contains error nodes)",
                    candidate.display_path
                ));
            }

            let mut file_had_match = false;
            for pattern in runnable_patterns {
                ct.heartbeat()?;
                for matched in ast.root().find_all(pattern.clone()) {
                    ct.heartbeat()?;
                    total_matches = total_matches.saturating_add(1);
                    if !file_had_match {
                        files_with_matches.insert(candidate.display_path.clone());
                        file_had_match = true;
                    }
                    let range = matched.range();
                    let start = matched.start_pos();
                    let end = matched.end_pos();
                    let key = AstFindOrderKey {
                        path: candidate.display_path.clone(),
                        start_line: to_u32(start.line().saturating_add(1)),
                        start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
                        end_line: to_u32(end.line().saturating_add(1)),
                        end_column: to_u32(end.column(matched.get_node()).saturating_add(1)),
                        byte_start: to_u32(range.start),
                        byte_end: to_u32(range.end),
                        sequence: match_sequence,
                    };
                    match_sequence = match_sequence.saturating_add(1);
                    if should_retain_match(&retained_matches, retained_capacity, &key) {
                        let meta_variables = if include_meta {
                            Some(HashMap::<String, String>::from(matched.get_env().clone()))
                        } else {
                            None
                        };
                        retain_bounded_match(
                            &mut retained_matches,
                            retained_capacity,
                            RetainedAstFindMatch {
                                key,
                                text: matched.text().into_owned(),
                                meta_variables,
                            },
                        );
                    }
                }
            }
        }

        let (matches, limit_reached) =
            page_retained_matches(retained_matches, normalized_offset, normalized_limit);
        let matches = matches.into_iter().map(retained_to_find_match).collect();

        Ok(AstFindResult {
            matches,
            total_matches,
            files_with_matches: to_u32(files_with_matches.len()),
            files_searched,
            limit_reached,
            parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
        })
    })
}

#[napi]
pub fn ast_match(options: AstMatchOptions<'_>) -> Promise<AstMatchResult> {
    let AstMatchOptions {
        source,
        lang,
        patterns,
        selector,
        strictness,
        limit,
        offset,
        include_meta,
        signal,
        timeout_ms,
    } = options;

    let cancel_token = CancelToken::new(timeout_ms, signal);
    let normalized_limit = limit.unwrap_or(DEFAULT_FIND_LIMIT).max(1);
    let normalized_offset = offset.unwrap_or(0);

    blocking(cancel_token, move |ct| {
        ct.heartbeat()?;
        let patterns = normalize_pattern_list(Some(patterns))?;
        let strictness = resolve_strictness(strictness);
        let include_meta = include_meta.unwrap_or(false);
        let lang_str = lang.trim();
        if lang_str.is_empty() {
            return Err(Error::from_reason("`lang` is required for ast_match"));
        }
        let language = resolve_supported_lang(lang_str)?;

        let mut parse_errors = Vec::new();
        let mut compiled_patterns = Vec::with_capacity(patterns.len());
        for pattern in &patterns {
            ct.heartbeat()?;
            match compile_pattern(pattern, selector.as_deref(), &strictness, language) {
                Ok(compiled) => compiled_patterns.push(compiled),
                Err(err) => parse_errors.push(format!("{pattern}: {err}")),
            }
        }

        let retained_capacity = retained_find_capacity(normalized_offset, normalized_limit);
        let mut retained_matches = BinaryHeap::new();
        let mut total_matches = 0u32;
        let mut match_sequence = 0u64;
        if !compiled_patterns.is_empty() {
            let ast = language.ast_grep(&source);
            if ast.root().dfs().any(|node| node.is_error()) {
                parse_errors.push("parse error (syntax tree contains error nodes)".to_string());
            }
            for pattern in &compiled_patterns {
                ct.heartbeat()?;
                for matched in ast.root().find_all(pattern.clone()) {
                    ct.heartbeat()?;
                    total_matches = total_matches.saturating_add(1);
                    let range = matched.range();
                    let start = matched.start_pos();
                    let end = matched.end_pos();
                    let key = AstFindOrderKey {
                        path: String::new(),
                        start_line: to_u32(start.line().saturating_add(1)),
                        start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
                        end_line: to_u32(end.line().saturating_add(1)),
                        end_column: to_u32(end.column(matched.get_node()).saturating_add(1)),
                        byte_start: to_u32(range.start),
                        byte_end: to_u32(range.end),
                        sequence: match_sequence,
                    };
                    match_sequence = match_sequence.saturating_add(1);
                    if should_retain_match(&retained_matches, retained_capacity, &key) {
                        let meta_variables = if include_meta {
                            Some(HashMap::<String, String>::from(matched.get_env().clone()))
                        } else {
                            None
                        };
                        retain_bounded_match(
                            &mut retained_matches,
                            retained_capacity,
                            RetainedAstFindMatch {
                                key,
                                text: matched.text().into_owned(),
                                meta_variables,
                            },
                        );
                    }
                }
            }
        }

        let (matches, limit_reached) =
            page_retained_matches(retained_matches, normalized_offset, normalized_limit);
        Ok(AstMatchResult {
            matches: matches.into_iter().map(retained_to_find_match).collect(),
            total_matches,
            limit_reached,
            parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
        })
    })
}

fn infer_single_replace_lang(candidates: &[FileCandidate], ct: &CancelToken) -> Result<String> {
    let mut inferred = BTreeSet::new();
    let mut unresolved = Vec::new();
    for candidate in candidates {
        ct.heartbeat()?;
        match resolve_language(None, &candidate.absolute_path) {
            Ok(language) => {
                inferred.insert(language.canonical_name().to_string());
            }
            Err(err) => unresolved.push(format!("{}: {err}", candidate.display_path)),
        }
    }
    if !unresolved.is_empty() {
        let details = unresolved
            .iter()
            .map(|entry| format!("- {entry}"))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(Error::from_reason(format!(
            "`lang` is required for ast_edit when language cannot be inferred from all files:\n{details}"
        )));
    }
    if inferred.is_empty() {
        return Err(Error::from_reason(
            "`lang` is required for ast_edit when no files match path/glob",
        ));
    }
    if inferred.len() > 1 {
        return Err(Error::from_reason(format!(
            "`lang` is required for ast_edit when path/glob resolves to multiple languages: {}",
            inferred.into_iter().collect::<Vec<_>>().join(", ")
        )));
    }
    Ok(inferred.into_iter().next().expect("non-empty inferred set"))
}

#[napi]
pub fn ast_edit(options: AstReplaceOptions<'_>) -> Promise<AstReplaceResult> {
    let AstReplaceOptions {
        rewrites,
        lang,
        path,
        glob,
        selector,
        strictness,
        dry_run,
        max_replacements,
        max_files,
        fail_on_parse_error,
        signal,
        timeout_ms,
    } = options;

    let cancel_token = CancelToken::new(timeout_ms, signal);
    blocking(cancel_token, move |ct| {
        ct.heartbeat()?;
        let rewrite_rules = normalize_rewrite_map(rewrites)?;
        let strictness = resolve_strictness(strictness);
        let dry_run = dry_run.unwrap_or(true);
        let max_replacements = max_replacements.unwrap_or(u32::MAX).max(1);
        let max_files = max_files.unwrap_or(u32::MAX).max(1);
        let fail_on_parse_error = fail_on_parse_error.unwrap_or(false);

        let lang_str = lang
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let candidates: Vec<_> = collect_candidates(path, glob.as_deref(), &ct)?
            .into_iter()
            .filter(|candidate| is_supported_file(&candidate.absolute_path, lang_str))
            .collect();
        let effective_lang = if let Some(lang) = lang_str {
            lang.to_string()
        } else {
            infer_single_replace_lang(&candidates, &ct)?
        };

        let language = resolve_supported_lang(&effective_lang)?;
        let mut parse_errors = Vec::new();
        let mut compiled_rules = Vec::new();
        for (pattern, rewrite) in rewrite_rules {
            ct.heartbeat()?;
            match compile_pattern(&pattern, selector.as_deref(), &strictness, language) {
                Ok(compiled) => compiled_rules.push((rewrite, compiled)),
                Err(err) => {
                    if fail_on_parse_error {
                        return Err(err);
                    }
                    parse_errors.push(format!("{pattern}: {err}"));
                }
            }
        }

        if compiled_rules.is_empty() {
            return Ok(AstReplaceResult {
                file_changes: vec![],
                total_replacements: 0,
                files_touched: 0,
                files_searched: to_u32(candidates.len()),
                applied: !dry_run,
                limit_reached: false,
                parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
                changes: vec![],
            });
        }

        let mut changes = Vec::new();
        let mut file_counts: BTreeMap<String, u32> = BTreeMap::new();
        let mut files_touched = 0u32;
        let mut limit_reached = false;
        let mut pending_writes = Vec::new();

        for candidate in &candidates {
            ct.heartbeat()?;
            let source = match std::fs::read_to_string(&candidate.absolute_path) {
                Ok(source) => source,
                Err(err) => {
                    if fail_on_parse_error {
                        return Err(Error::from_reason(format!(
                            "{}: {err}",
                            candidate.display_path
                        )));
                    }
                    parse_errors.push(format!("{}: {err}", candidate.display_path));
                    continue;
                }
            };

            let ast = language.ast_grep(&source);
            if ast.root().dfs().any(|node| node.is_error()) {
                let parse_issue = format!(
                    "{}: parse error (syntax tree contains error nodes)",
                    candidate.display_path
                );
                if fail_on_parse_error {
                    return Err(Error::from_reason(parse_issue));
                }
                parse_errors.push(parse_issue);
                continue;
            }

            let mut file_changes = Vec::new();
            let mut reached_max_replacements = false;
            'patterns: for (rewrite, compiled) in &compiled_rules {
                ct.heartbeat()?;
                for matched in ast.root().find_all(compiled.clone()) {
                    ct.heartbeat()?;
                    if changes.len() + file_changes.len() >= max_replacements as usize {
                        limit_reached = true;
                        reached_max_replacements = true;
                        break 'patterns;
                    }
                    let edit = matched.replace_by(rewrite.as_str());
                    let range = matched.range();
                    let start = matched.start_pos();
                    let end = matched.end_pos();
                    let after = String::from_utf8(edit.inserted_text.clone()).map_err(|err| {
                        Error::from_reason(format!(
                            "{}: replacement text is not valid UTF-8: {err}",
                            candidate.display_path
                        ))
                    })?;
                    file_changes.push(PendingFileChange {
                        change: AstReplaceChange {
                            path: candidate.display_path.clone(),
                            before: matched.text().into_owned(),
                            after,
                            byte_start: to_u32(range.start),
                            byte_end: to_u32(range.end),
                            deleted_length: to_u32(edit.deleted_length),
                            start_line: to_u32(start.line().saturating_add(1)),
                            start_column: to_u32(
                                start.column(matched.get_node()).saturating_add(1),
                            ),
                            end_line: to_u32(end.line().saturating_add(1)),
                            end_column: to_u32(end.column(matched.get_node()).saturating_add(1)),
                        },
                        edit,
                    });
                }
            }

            if file_changes.is_empty() {
                if reached_max_replacements {
                    break;
                }
                continue;
            }
            if files_touched >= max_files {
                limit_reached = true;
                break;
            }
            files_touched = files_touched.saturating_add(1);
            file_counts.insert(candidate.display_path.clone(), to_u32(file_changes.len()));

            if !dry_run {
                let edits = file_changes
                    .iter()
                    .map(|entry| Edit {
                        position: entry.edit.position,
                        deleted_length: entry.edit.deleted_length,
                        inserted_text: entry.edit.inserted_text.clone(),
                    })
                    .collect::<Vec<_>>();
                let output = apply_edits(&source, &edits)?;
                if output != source {
                    pending_writes.push(PendingWrite {
                        absolute_path: candidate.absolute_path.clone(),
                        output,
                    });
                }
            }

            changes.extend(file_changes.into_iter().map(|entry| entry.change));
            if reached_max_replacements {
                break;
            }
        }

        if !dry_run {
            for write in &pending_writes {
                ct.heartbeat()?;
                std::fs::write(&write.absolute_path, &write.output).map_err(|err| {
                    Error::from_reason(format!(
                        "Failed to write {}: {err}",
                        write.absolute_path.display()
                    ))
                })?;
            }
        }

        let file_changes = file_counts
            .into_iter()
            .map(|(path, count)| AstReplaceFileChange { path, count })
            .collect::<Vec<_>>();

        Ok(AstReplaceResult {
            file_changes,
            total_replacements: to_u32(changes.len()),
            files_touched,
            files_searched: to_u32(candidates.len()),
            applied: !dry_run,
            limit_reached,
            parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
            changes,
        })
    })
}
