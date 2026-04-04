/**
 * BananaHub API — Cloudflare Worker
 *
 * Install and usage tracking for the BananaHub template ecosystem.
 * Uses Workers KV (namespace binding: INSTALLS) to persist counters.
 *
 * KV key schema
 * ─────────────
 *   count:{repo}:{template_id}        per-template total   (no TTL)
 *   repo-count:{repo}                 repo-level aggregate (no TTL)
 *   daily:{YYYY-MM-DD}:{repo}:{template_id}   trending    (TTL 7d)
 *   usage-count:{event}:{repo}:{template_id}          usage total          (no TTL)
 *   usage-daily:{YYYY-MM-DD}:{event}:{repo}:{template_id}   usage 24h      (TTL 7d)
 *   usage-unique:{event}:{repo}:{template_id}:{anon}  unique marker        (no TTL)
 *   usage-unique-count:{event}:{repo}:{template_id}   usage unique total   (no TTL)
 *   discovered:{repo}:{template_id}   discovered candidate metadata (no TTL)
 *   ratelimit:{ip}:{minute}           rate-limit counter   (TTL 120s)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const KNOWN_SHORT_INSTALL_ROOTS = new Set(["references/templates", "templates"]);
const CANONICAL_REPO_ALIASES = new Map([
  ["nano-banana-hub/nanobanana", "bananahub-ai/bananahub-skill"],
]);
const VALID_USAGE_EVENTS = new Set(["selected", "generate_success", "edit_success"]);
const VALID_TEMPLATE_DISTRIBUTIONS = new Set(["bundled", "remote"]);
const VALID_CATALOG_SOURCES = new Set(["curated", "discovered"]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/** Return the current UTC minute key for rate-limiting (e.g. "2026-03-25T14:07"). */
function minuteKey() {
  const d = new Date();
  return d.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

/** Return today's UTC date string (YYYY-MM-DD). */
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function clampLimit(rawValue, fallback = 100, max = 1000) {
  let limit = parseInt(rawValue || String(fallback), 10);
  if (Number.isNaN(limit) || limit < 1) {
    limit = fallback;
  }
  return Math.min(limit, max);
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/^\/+|\/+$/g, "");
}

function normalizeRepo(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function canonicalizeRepo(value) {
  const repo = normalizeRepo(value);
  if (!repo) {
    return "";
  }

  return CANONICAL_REPO_ALIASES.get(repo.toLowerCase()) || repo;
}

function repoKeyVariants(value) {
  const canonicalRepo = canonicalizeRepo(value);
  const variants = new Set([canonicalRepo]);

  for (const [alias, canonical] of CANONICAL_REPO_ALIASES.entries()) {
    if (canonical.toLowerCase() === canonicalRepo.toLowerCase()) {
      variants.add(alias);
    }
  }

  return Array.from(variants).filter(Boolean);
}

function rewriteRepoPrefix(value, fromRepo, toRepo) {
  const input = normalizeRepo(value);
  if (!input) {
    return input;
  }

  if (input === fromRepo) {
    return toRepo;
  }

  if (input.startsWith(`${fromRepo}/`)) {
    return `${toRepo}${input.slice(fromRepo.length)}`;
  }

  return input;
}

function normalizeOfficialInstallTarget(repo, installTarget) {
  const normalizedTarget = normalizeOptionalString(installTarget);
  const repoPrefix = `${repo}/`;
  if (!normalizedTarget.startsWith(repoPrefix)) {
    return normalizedTarget;
  }

  const tail = normalizeOptionalString(normalizedTarget.slice(repoPrefix.length));
  for (const root of KNOWN_SHORT_INSTALL_ROOTS) {
    const prefix = `${root}/`;
    if (tail.startsWith(prefix)) {
      return `${repo}/${tail.slice(prefix.length)}`;
    }
  }

  return normalizedTarget;
}

function normalizeDiscoveredCandidate(candidate) {
  const originalRepo = normalizeRepo(candidate?.repo);
  const canonicalRepo = canonicalizeRepo(originalRepo);
  const normalized = {
    ...candidate,
    repo: canonicalRepo,
  };

  if (canonicalRepo !== originalRepo) {
    normalized.install_target = normalizeOfficialInstallTarget(
      canonicalRepo,
      rewriteRepoPrefix(candidate?.install_target, originalRepo, canonicalRepo)
    );
  } else {
    normalized.install_target = normalizeOptionalString(candidate?.install_target);
  }

  normalized.template_path = normalizeOptionalString(candidate?.template_path);
  return normalized;
}

function mergeDiscoveredCandidates(left, right) {
  const firstSeenCandidates = [left?.first_seen_at, right?.first_seen_at].filter(Boolean).sort();
  const lastSeenCandidates = [left?.last_seen_at, right?.last_seen_at].filter(Boolean).sort().reverse();
  const latestRecord = [left, right]
    .filter(Boolean)
    .sort((a, b) => String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || "")))[0] || null;

  return {
    ...left,
    ...right,
    repo: left.repo || right.repo,
    template_id: left.template_id || right.template_id,
    template_path: left.template_path || right.template_path || "",
    install_target: left.install_target || right.install_target || "",
    first_seen_at: firstSeenCandidates[0] || "",
    last_seen_at: lastSeenCandidates[0] || "",
    install_events: (left.install_events || 0) + (right.install_events || 0),
    latest_cli_version: latestRecord?.latest_cli_version || left.latest_cli_version || right.latest_cli_version || "",
  };
}

function normalizeUsageEvent(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  return VALID_USAGE_EVENTS.has(normalized) ? normalized : "";
}

function normalizeEnum(value, allowedValues) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  return allowedValues.has(normalized) ? normalized : "";
}

function normalizeAnonymousId(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    return "";
  }

  return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : "";
}

function parseCount(rawValue) {
  return rawValue ? parseInt(rawValue, 10) : 0;
}

async function upsertDiscoveredCandidate(env, body, repo, templateId) {
  const canonicalRepo = canonicalizeRepo(repo);
  const key = `discovered:${canonicalRepo}:${templateId}`;
  const now = new Date().toISOString();

  let existing = null;
  try {
    const raw = await env.INSTALLS.get(key);
    existing = raw ? JSON.parse(raw) : null;
  } catch {
    existing = null;
  }

  const templatePath = normalizeOptionalString(body.template_path);
  const installTarget = normalizeOfficialInstallTarget(
    canonicalRepo,
    typeof body.install_target === "string"
      ? rewriteRepoPrefix(body.install_target, repo, canonicalRepo)
      : ""
  );
  const cliVersion = typeof body.cli_version === "string" ? body.cli_version.trim() : "";

  const candidate = {
    repo: canonicalRepo,
    template_id: templateId,
    template_path: templatePath || existing?.template_path || "",
    install_target: installTarget || existing?.install_target || "",
    first_seen_at: existing?.first_seen_at || now,
    last_seen_at: now,
    install_events: (existing?.install_events || 0) + 1,
  };

  if (cliVersion) {
    candidate.latest_cli_version = cliVersion;
  } else if (existing?.latest_cli_version) {
    candidate.latest_cli_version = existing.latest_cli_version;
  }

  await env.INSTALLS.put(key, JSON.stringify(candidate));
}

async function incrementCounter(env, key, delta = 1, options) {
  const rawValue = await env.INSTALLS.get(key);
  const nextValue = parseCount(rawValue) + delta;
  await env.INSTALLS.put(key, String(nextValue), options);
  return nextValue;
}

async function readUsageStats(env, repo, templateId) {
  const events = ["selected", "generate_success", "edit_success"];
  const today = todayUTC();
  const keys = [];
  const canonicalRepo = canonicalizeRepo(repo);
  const variants = repoKeyVariants(canonicalRepo);

  for (const repoVariant of variants) {
    for (const event of events) {
      keys.push(`usage-count:${event}:${repoVariant}:${templateId}`);
      keys.push(`usage-unique-count:${event}:${repoVariant}:${templateId}`);
      keys.push(`usage-daily:${today}:${event}:${repoVariant}:${templateId}`);
    }
  }

  const values = await Promise.all(keys.map((key) => env.INSTALLS.get(key)));
  const stats = {};

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    stats[event] = {
      total: 0,
      unique: 0,
      last_24h: 0,
    };
  }

  let offset = 0;
  for (const _repoVariant of variants) {
    for (const event of events) {
      stats[event].total += parseCount(values[offset]);
      stats[event].unique += parseCount(values[offset + 1]);
      stats[event].last_24h += parseCount(values[offset + 2]);
      offset += 3;
    }
  }

  return {
    repo: canonicalRepo,
    template_id: templateId,
    selected: stats.selected,
    generate_success: stats.generate_success,
    edit_success: stats.edit_success,
    success_total: stats.generate_success.total + stats.edit_success.total,
    success_24h: stats.generate_success.last_24h + stats.edit_success.last_24h,
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/installs
 *
 * Record an install event.  Increments three KV counters and enforces a
 * per-IP rate limit of 10 writes per minute.
 */
async function handleInstalls(request, env) {
  // --- Parse & validate body ---------------------------------------------------
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const repo = canonicalizeRepo(body.repo);
  const template_id = typeof body.template_id === "string" ? body.template_id.trim() : "";

  if (!repo || !repo.includes("/")) {
    return json({ error: "invalid_repo", message: "repo is required and must contain '/'" }, 400);
  }
  if (!template_id) {
    return json({ error: "invalid_template_id", message: "template_id is required" }, 400);
  }

  // --- Rate limiting (10 writes/min per IP) ------------------------------------
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `ratelimit:${ip}:${minuteKey()}`;
  const rlRaw = await env.INSTALLS.get(rlKey);
  const rlCount = rlRaw ? parseInt(rlRaw, 10) : 0;

  if (rlCount >= 10) {
    return json({ error: "rate_limited", retry_after: 60 }, 429);
  }

  // Increment rate-limit counter (TTL 120 s keeps it short-lived)
  await env.INSTALLS.put(rlKey, String(rlCount + 1), { expirationTtl: 120 });

  // --- Increment counters ------------------------------------------------------
  const countKey = `count:${repo}:${template_id}`;
  const repoKey = `repo-count:${repo}`;
  const dailyKey = `daily:${todayUTC()}:${repo}:${template_id}`;

  // Read current values in parallel
  const [countRaw, repoCountRaw, dailyRaw] = await Promise.all([
    env.INSTALLS.get(countKey),
    env.INSTALLS.get(repoKey),
    env.INSTALLS.get(dailyKey),
  ]);

  const newCount = (countRaw ? parseInt(countRaw, 10) : 0) + 1;
  const newRepoCount = (repoCountRaw ? parseInt(repoCountRaw, 10) : 0) + 1;
  const newDaily = (dailyRaw ? parseInt(dailyRaw, 10) : 0) + 1;

  // Write updated values in parallel
  await Promise.all([
    env.INSTALLS.put(countKey, String(newCount)),
    env.INSTALLS.put(repoKey, String(newRepoCount)),
    env.INSTALLS.put(dailyKey, String(newDaily), { expirationTtl: 604800 }), // 7 days
    upsertDiscoveredCandidate(env, body, repo, template_id),
  ]);

  return json({ ok: true });
}

/**
 * POST /api/usage
 *
 * Record a template usage event such as selected or successful generation/edit.
 */
async function handleUsage(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const repo = canonicalizeRepo(body.repo);
  const templateId = typeof body.template_id === "string" ? body.template_id.trim() : "";
  const event = normalizeUsageEvent(body.event);
  const anonymousId = normalizeAnonymousId(body.anonymous_id);

  if (!repo || !repo.includes("/")) {
    return json({ error: "invalid_repo", message: "repo is required and must contain '/'" }, 400);
  }
  if (!templateId) {
    return json({ error: "invalid_template_id", message: "template_id is required" }, 400);
  }
  if (!event) {
    return json({ error: "invalid_event", message: "event must be one of selected, generate_success, edit_success" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `usage-ratelimit:${ip}:${minuteKey()}`;
  const rlCount = parseCount(await env.INSTALLS.get(rlKey));
  if (rlCount >= 60) {
    return json({ error: "rate_limited", retry_after: 60 }, 429);
  }
  await env.INSTALLS.put(rlKey, String(rlCount + 1), { expirationTtl: 120 });

  const countKey = `usage-count:${event}:${repo}:${templateId}`;
  const dailyKey = `usage-daily:${todayUTC()}:${event}:${repo}:${templateId}`;
  const metadata = {
    repo,
    template_id: templateId,
    event,
    distribution: normalizeEnum(body.distribution, VALID_TEMPLATE_DISTRIBUTIONS),
    catalog_source: normalizeEnum(body.catalog_source, VALID_CATALOG_SOURCES),
    command: typeof body.command === "string" ? body.command.trim() : "",
    client_ts: typeof body.client_ts === "string" ? body.client_ts.trim() : "",
    last_seen_at: new Date().toISOString(),
  };

  await Promise.all([
    incrementCounter(env, countKey),
    incrementCounter(env, dailyKey, 1, { expirationTtl: 604800 }),
    env.INSTALLS.put(`usage-meta:${event}:${repo}:${templateId}`, JSON.stringify(metadata)),
  ]);

  if (anonymousId) {
    const uniqueMarkerKey = `usage-unique:${event}:${repo}:${templateId}:${anonymousId}`;
    const markerExists = await env.INSTALLS.get(uniqueMarkerKey);
    if (!markerExists) {
      await Promise.all([
        env.INSTALLS.put(uniqueMarkerKey, metadata.last_seen_at),
        incrementCounter(env, `usage-unique-count:${event}:${repo}:${templateId}`),
      ]);
    }
  }

  return json({ ok: true });
}

/**
 * GET /api/stats?repo=...&template_id=...
 *
 * Return install counts for a repo or specific template.
 */
async function handleStats(url, env) {
  const repo = canonicalizeRepo(url.searchParams.get("repo"));
  if (!repo) {
    return json({ error: "missing_repo", message: "repo query parameter is required" }, 400);
  }

  const templateId = url.searchParams.get("template_id");
  const repoVariants = repoKeyVariants(repo);

  if (templateId) {
    const values = await Promise.all(
      repoVariants.map((repoVariant) => env.INSTALLS.get(`count:${repoVariant}:${templateId}`))
    );
    return json({
      repo,
      template_id: templateId,
      installs: values.reduce((sum, value) => sum + parseCount(value), 0),
    });
  }

  const values = await Promise.all(
    repoVariants.map((repoVariant) => env.INSTALLS.get(`repo-count:${repoVariant}`))
  );
  return json({
    repo,
    installs: values.reduce((sum, value) => sum + parseCount(value), 0),
  });
}

/**
 * GET /api/usage-stats?repo=...&template_id=...
 *
 * Return usage/adoption counts for a specific template.
 */
async function handleUsageStats(url, env) {
  const repo = canonicalizeRepo(url.searchParams.get("repo"));
  const templateId = url.searchParams.get("template_id");

  if (!repo) {
    return json({ error: "missing_repo", message: "repo query parameter is required" }, 400);
  }
  if (!templateId) {
    return json({ error: "missing_template_id", message: "template_id query parameter is required" }, 400);
  }

  return json(await readUsageStats(env, repo, templateId));
}

/**
 * GET /api/trending?period=24h|7d&limit=20
 *
 * Aggregate daily install keys and return a ranked list.
 */
async function handleTrending(url, env) {
  const period = url.searchParams.get("period") || "24h";
  const limit = clampLimit(url.searchParams.get("limit"), 20, 100);

  // Determine which dates to include
  const today = todayUTC();
  let datesToInclude;
  if (period === "7d") {
    datesToInclude = new Set();
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      datesToInclude.add(d.toISOString().slice(0, 10));
    }
  } else {
    // Default to 24h — today only
    datesToInclude = new Set([today]);
  }

  // Scan daily: prefix keys via KV.list()
  // KV.list returns up to 1000 keys per call; page through if needed.
  const aggregated = {}; // "repo:template_id" -> total
  const readTasks = [];

  let cursor = undefined;
  let done = false;

  while (!done) {
    const listOpts = { prefix: "daily:", limit: 1000 };
    if (cursor) listOpts.cursor = cursor;

    const result = await env.INSTALLS.list(listOpts);

    for (const key of result.keys) {
      // key.name = "daily:YYYY-MM-DD:owner/repo:template_id"
      const parts = key.name.split(":");
      // parts[0] = "daily"
      // parts[1] = "YYYY-MM-DD"
      // parts[2] = "owner/repo"  (contains /)
      // parts[3] = template_id
      if (parts.length < 4) continue;

      const date = parts[1];
      if (!datesToInclude.has(date)) continue;

      const repo = canonicalizeRepo(parts[2]);
      const templateId = parts.slice(3).join(":"); // handle template_ids with colons
      const compositeKey = `${repo}:${templateId}`;

      if (!(compositeKey in aggregated)) {
        aggregated[compositeKey] = { repo, template_id: templateId, installs: 0 };
      }

      readTasks.push({
        compositeKey,
        kvKey: key.name,
      });
    }

    if (result.list_complete) {
      done = true;
    } else {
      cursor = result.cursor;
    }
  }

  // Read values in batches of 50 to avoid overwhelming KV
  const BATCH = 50;
  for (let i = 0; i < readTasks.length; i += BATCH) {
    const batch = readTasks.slice(i, i + BATCH);
    const values = await Promise.all(batch.map((t) => env.INSTALLS.get(t.kvKey)));
    for (let j = 0; j < batch.length; j++) {
      if (values[j]) {
        aggregated[batch[j].compositeKey].installs += parseInt(values[j], 10);
      }
    }
  }

  // Sort descending by installs, apply limit
  const sorted = Object.values(aggregated)
    .filter((t) => t.installs > 0)
    .sort((a, b) => b.installs - a.installs)
    .slice(0, limit);

  return json({ period, templates: sorted });
}

/**
 * GET /api/discovered?limit=200
 *
 * Return discovered template candidates inferred from install events.
 */
async function handleDiscovered(url, env) {
  const limit = clampLimit(url.searchParams.get("limit"), 200, 1000);
  const candidates = new Map();

  let cursor = undefined;
  let done = false;

  while (!done) {
    const listOpts = { prefix: "discovered:", limit: 1000 };
    if (cursor) listOpts.cursor = cursor;

    const result = await env.INSTALLS.list(listOpts);

    const batchValues = await Promise.all(
      result.keys.map((key) =>
        env.INSTALLS.get(key.name).catch(() => null)
      )
    );

    for (const rawValue of batchValues) {
      if (!rawValue) continue;

      try {
        const parsed = normalizeDiscoveredCandidate(JSON.parse(rawValue));
        if (!parsed?.repo || !parsed?.template_id) {
          continue;
        }
        const key = `${parsed.repo}:${parsed.template_id}`;
        const existing = candidates.get(key);
        candidates.set(key, existing ? mergeDiscoveredCandidates(existing, parsed) : parsed);
      } catch {
        // Ignore malformed discovered entries.
      }
    }

    if (result.list_complete) {
      done = true;
    } else {
      cursor = result.cursor;
    }
  }

  const items = Array.from(candidates.values());

  items.sort((left, right) => {
    const installsDiff = (right.install_events || 0) - (left.install_events || 0);
    if (installsDiff !== 0) {
      return installsDiff;
    }

    return String(right.last_seen_at || "").localeCompare(String(left.last_seen_at || ""));
  });

  return json({
    total: items.length,
    items: items.slice(0, limit),
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST /api/installs
    if (method === "POST" && pathname === "/api/installs") {
      return handleInstalls(request, env);
    }

    // GET /api/stats
    if (method === "GET" && pathname === "/api/stats") {
      return handleStats(url, env);
    }

    // POST /api/usage
    if (method === "POST" && pathname === "/api/usage") {
      return handleUsage(request, env);
    }

    // GET /api/usage-stats
    if (method === "GET" && pathname === "/api/usage-stats") {
      return handleUsageStats(url, env);
    }

    // GET /api/trending
    if (method === "GET" && pathname === "/api/trending") {
      return handleTrending(url, env);
    }

    // GET /api/discovered
    if (method === "GET" && pathname === "/api/discovered") {
      return handleDiscovered(url, env);
    }

    return json({ error: "not_found" }, 404);
  },
};
