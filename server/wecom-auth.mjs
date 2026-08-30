import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ProxyAgent } from "undici";

const SESSION_COOKIE = "dashi_wecom_session";

function enabled(value) {
  return value === true || value === "1" || value === "true";
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function commaSeparated(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function equalSecret(left, right) {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function loopbackAddress(value) {
  if (typeof value !== "string") return false;
  const address = value.toLowerCase().split("%", 1)[0];
  return address === "::1"
    || address.startsWith("127.")
    || address.startsWith("::ffff:127.");
}

function cookieValue(request, name) {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator === -1) continue;
    if (item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function sessionCookie(token, { secure, maxAge }) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function clearSessionCookie({ secure }) {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function redirect(response, location, cookie) {
  response.statusCode = 302;
  response.setHeader("cache-control", "no-store");
  response.setHeader("location", location);
  if (cookie) response.setHeader("set-cookie", cookie);
  response.end();
}

function sendError(response, status, message) {
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>企业微信登录失败</title><body><main><h2>无法打开任务看板</h2><p>${message}</p></main></body></html>`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

function sendUnauthorized(response) {
  const body = JSON.stringify({
    error: {
      code: "WECOM_AUTH_REQUIRED",
      message: "请从企业微信应用重新打开任务看板。",
    },
  });
  response.writeHead(401, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function expiresAt(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function wecomJson(fetchImplementation, url) {
  const response = await fetchImplementation(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.errcode !== undefined && body.errcode !== 0)) {
    const error = new Error(`WeCom API request failed (${body.errcode ?? response.status})`);
    error.code = "WECOM_API_ERROR";
    throw error;
  }
  return body;
}

export function resolveWeComConfig(overrides = {}) {
  const environment = process.env;
  const isEnabled = enabled(overrides.enabled ?? environment.CODEX_TASKBOARD_WECOM_ENABLED);
  const agentId = String(overrides.agentId ?? environment.CODEX_TASKBOARD_WECOM_AGENT_ID ?? "").trim();
  if (isEnabled && !agentId) {
    throw new Error("CODEX_TASKBOARD_WECOM_AGENT_ID is required when WeCom is enabled");
  }
  const publicUrl = String(overrides.publicUrl ?? environment.CODEX_TASKBOARD_WECOM_PUBLIC_URL ?? "").trim();
  const basePath = `/wecom/app/${encodeURIComponent(agentId)}/taskboard`;
  let publicOrigin = null;
  if (publicUrl) {
    const parsed = new URL(publicUrl);
    publicOrigin = parsed.origin;
    if (parsed.protocol !== "https:" || parsed.pathname.replace(/\/$/, "") !== basePath) {
      throw new Error(`CODEX_TASKBOARD_WECOM_PUBLIC_URL must be an HTTPS URL ending in '${basePath}'`);
    }
  }
  return {
    enabled: isEnabled,
    corpId: String(overrides.corpId ?? environment.CODEX_TASKBOARD_WECOM_CORP_ID ?? "").trim(),
    agentId,
    secret: String(overrides.secret ?? environment.CODEX_TASKBOARD_WECOM_SECRET ?? "").trim(),
    allowedUserIds: commaSeparated(
      overrides.allowedUserIds ?? environment.CODEX_TASKBOARD_WECOM_ALLOWED_USER_IDS,
    ),
    adminUserIds: commaSeparated(
      overrides.adminUserIds ?? environment.CODEX_TASKBOARD_ADMIN_USER_IDS,
    ),
    serviceSecret: String(
      overrides.serviceSecret ?? environment.CODEX_TASKBOARD_SERVICE_SECRET ?? "",
    ),
    publicUrl: publicUrl.replace(/\/$/, ""),
    publicOrigin,
    proxyUrl: String(
      overrides.proxyUrl ?? environment.CODEX_TASKBOARD_WECOM_PROXY_URL ?? "",
    ).trim(),
    basePath,
    devMode: enabled(overrides.devMode ?? environment.CODEX_TASKBOARD_WECOM_DEV_MODE),
    devUserId: String(overrides.devUserId ?? environment.CODEX_TASKBOARD_WECOM_DEV_USER_ID ?? "TianJiYuan").trim(),
    devUserName: String(overrides.devUserName ?? environment.CODEX_TASKBOARD_WECOM_DEV_USER_NAME ?? "TianJiYuan").trim(),
    sessionTtlSeconds: positiveInteger(
      overrides.sessionTtlSeconds ?? environment.CODEX_TASKBOARD_WECOM_SESSION_TTL_SECONDS,
      8 * 60 * 60,
    ),
    stateTtlSeconds: positiveInteger(
      overrides.stateTtlSeconds ?? environment.CODEX_TASKBOARD_WECOM_STATE_TTL_SECONDS,
      10 * 60,
    ),
  };
}

export function createWeComAuth({ database, config, fetch: fetchImplementation = globalThis.fetch }) {
  const proxyDispatcher = config.proxyUrl ? new ProxyAgent(config.proxyUrl) : null;
  const fetchWeCom = (url, options) => fetchImplementation(url, {
    ...options,
    ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
  });

  function actorFromSession(request) {
    if (!config.enabled) return null;
    const token = cookieValue(request, SESSION_COOKIE);
    if (!token) return null;
    const session = database.getWeComSession(token, config.agentId);
    if (!session) return null;
    return {
      type: "user",
      id: session.userId,
      name: session.userName,
      avatarUrl: session.avatarUrl,
    };
  }

  function actorFromBasic(request) {
    if (!config.serviceSecret) return null;
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Basic ")) return null;
    let decoded;
    try {
      decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    } catch {
      return null;
    }
    const separator = decoded.indexOf(":");
    if (separator < 1 || !equalSecret(decoded.slice(separator + 1), config.serviceSecret)) return null;
    const username = decoded.slice(0, separator).trim();
    if (!username || username.length > 120) return null;
    const userId = `basic:${encodeURIComponent(username.toLowerCase())}`;
    if (request.headers["x-taskboard-client"] === "cloud-companion") {
      const actingId = String(request.headers["x-taskboard-acting-user-id"] ?? "").trim();
      let actingName;
      try {
        actingName = decodeURIComponent(String(request.headers["x-taskboard-acting-user-name"] ?? ""));
      } catch {
        return null;
      }
      const actingAvatar = String(request.headers["x-taskboard-acting-user-avatar"] ?? "").trim();
      if (!actingId || actingId.length > 96 || !actingName || actingName.length > 120 || actingAvatar.length > 2048) {
        return null;
      }
      return {
        type: "user",
        id: actingId,
        name: actingName,
        avatarUrl: actingAvatar || null,
      };
    }
    const clientTag = request.headers["x-taskboard-client"];
    if (typeof clientTag === "string" && clientTag.length > 0 && clientTag.length <= 64) {
      return {
        type: "agent",
        id: `${userId}:${clientTag}`,
        username,
        name: clientTag === "workbuddy-bridge"
          ? `WorkBuddy Bridge (${username})`
          : `Agent (${username})`,
        avatarUrl: null,
      };
    }
    return { type: "user", id: userId, name: username, avatarUrl: null };
  }

  function actorFromLocalTaskctl(request) {
    if (request.headers["x-taskboard-client"] !== "taskctl") return null;
    if (
      request.headers["x-forwarded-for"] !== undefined
      || request.headers["x-real-ip"] !== undefined
      || request.headers.forwarded !== undefined
    ) {
      return null;
    }
    if (!loopbackAddress(request.socket?.remoteAddress)) return null;
    // Canonical Codex Agent identity: taskctl rows have always recorded
    // creator/author id "codex-agent" (see CODEX_AGENT_ACTOR in app.mjs).
    return {
      type: "agent",
      id: "codex-agent",
      name: "Codex Agent",
      avatarUrl: null,
    };
  }

  function actorFromRequest(request) {
    return actorFromSession(request) ?? actorFromBasic(request) ?? actorFromLocalTaskctl(request);
  }

  function roleFromRequest(request, actor = actorFromRequest(request)) {
    // Service credentials authenticate a bridge or worker; they never grant
    // human governance rights. Project/global administration is intentionally
    // reserved for an authenticated user session.
    if (actor?.type === "agent" || actor?.id?.startsWith("basic:")) return "member";
    if (actor) return config.adminUserIds.includes(actor.id) ? "admin" : "member";
    if (!config.enabled || (
      loopbackAddress(request.socket?.remoteAddress)
      && request.headers["x-forwarded-for"] === undefined
      && request.headers["x-real-ip"] === undefined
      && request.headers.forwarded === undefined
    )) return "admin";
    return "member";
  }

  function createSession(actor) {
    const token = randomBytes(32).toString("base64url");
    database.createWeComSession({
      id: token,
      agentId: config.agentId,
      userId: actor.id,
      userName: actor.name,
      avatarUrl: actor.avatarUrl,
      expiresAt: expiresAt(config.sessionTtlSeconds),
    });
    return token;
  }

  async function oauthActor(code) {
    if (!config.corpId || !config.secret) {
      throw new Error("WeCom application credentials are not configured");
    }
    const tokenResult = await wecomJson(
      fetchWeCom,
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(config.secret)}`,
    );
    const accessToken = String(tokenResult.access_token ?? "");
    const identity = await wecomJson(
      fetchWeCom,
      `https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo?access_token=${encodeURIComponent(accessToken)}&code=${encodeURIComponent(code)}`,
    );
    const userId = String(identity.UserId ?? identity.OpenId ?? "").trim();
    if (!userId) throw new Error("WeCom OAuth response did not include a user identity");
    const normalizedAllowed = config.allowedUserIds.map((id) => id.trim().toLowerCase());
    if (normalizedAllowed.length > 0 && !normalizedAllowed.includes(userId.toLowerCase())) {
      const error = new Error(`WeCom user is not allowed to access this Taskboard (userId=${userId})`);
      error.code = "WECOM_USER_NOT_ALLOWED";
      throw error;
    }
    let name = userId;
    let avatarUrl = null;
    if (identity.UserId) {
      try {
        const profile = await wecomJson(
          fetchWeCom,
          `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${encodeURIComponent(accessToken)}&userid=${encodeURIComponent(userId)}`,
        );
        name = String(profile.name ?? userId).trim() || userId;
        avatarUrl = typeof profile.avatar === "string" && profile.avatar ? profile.avatar : null;
      } catch {
        // The app can have OAuth permission without address-book detail permission.
      }
    }
    return { type: "user", id: userId, name, avatarUrl };
  }

  function beginOAuth(response) {
    if (!config.corpId || !config.publicUrl) {
      sendError(response, 503, "企业微信 OAuth 入口尚未配置完成。");
      return;
    }
    const state = randomBytes(32).toString("base64url");
    database.createWeComOAuthState(state, config.agentId, expiresAt(config.stateTtlSeconds));
    const callback = `${config.publicUrl}/oauth/callback`;
    const target = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
    target.searchParams.set("appid", config.corpId);
    target.searchParams.set("redirect_uri", callback);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("scope", "snsapi_base");
    target.searchParams.set("agentid", config.agentId);
    target.searchParams.set("state", state);
    redirect(response, `${target.toString()}#wechat_redirect`);
  }

  async function handle(request, response, url) {
    if (!config.enabled) return { handled: false, pathname: url.pathname };
    const rootPath = url.pathname.replace(/\/$/, "");
    if (rootPath === config.basePath) {
      if (actorFromRequest(request)) {
        if (url.pathname.endsWith("/")) return { handled: false, pathname: "/" };
        redirect(response, `${config.basePath}/${url.search}`);
        return { handled: true, pathname: rootPath };
      }
      if (config.devMode && loopbackAddress(request.socket.remoteAddress)) {
        const actor = {
          type: "user",
          id: config.devUserId,
          name: config.devUserName,
          avatarUrl: null,
        };
        const token = createSession(actor);
        redirect(response, `${config.basePath}/${url.search}`, sessionCookie(token, {
          secure: false,
          maxAge: config.sessionTtlSeconds,
        }));
        return { handled: true, pathname: rootPath };
      }
      beginOAuth(response);
      return { handled: true, pathname: rootPath };
    }

    if (url.pathname === `${config.basePath}/oauth/callback`) {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!code || !state || !database.consumeWeComOAuthState(state, config.agentId)) {
        sendError(response, 401, "授权请求已失效，请从企业微信重新打开应用。");
        return { handled: true, pathname: url.pathname };
      }
      try {
        const actor = await oauthActor(code);
        const token = createSession(actor);
        redirect(response, config.publicUrl, sessionCookie(token, {
          secure: true,
          maxAge: config.sessionTtlSeconds,
        }));
      } catch (error) {
        console.error("WeCom OAuth callback failed:", error?.code ?? "", error?.message ?? error);
        sendError(response, 401, `企业微信身份验证失败，请重新打开应用。（${error?.message ?? "unknown"}）`);
      }
      return { handled: true, pathname: url.pathname };
    }

    if (url.pathname === `${config.basePath}/logout`) {
      const token = cookieValue(request, SESSION_COOKIE);
      if (token) database.deleteWeComSession(token);
      redirect(response, config.basePath, clearSessionCookie({ secure: Boolean(config.publicUrl) }));
      return { handled: true, pathname: url.pathname };
    }

    if (url.pathname.startsWith(`${config.basePath}/`)) {
      if (!config.devMode && !actorFromRequest(request)) {
        if (url.pathname.startsWith(`${config.basePath}/api/`)) sendUnauthorized(response);
        else redirect(response, config.basePath);
        return { handled: true, pathname: url.pathname };
      }
      const pathname = url.pathname.slice(config.basePath.length) || "/";
      return { handled: false, pathname };
    }

    if (/^\/wecom\/app\/[^/]+\/taskboard(?:\/|$)/.test(url.pathname)) {
      sendError(response, 404, "企业微信应用入口不存在。");
      return { handled: true, pathname: url.pathname };
    }

    if (!config.devMode && !actorFromRequest(request) && url.pathname !== "/health") {
      if (url.pathname.startsWith("/api/")) sendUnauthorized(response);
      else redirect(response, config.basePath);
      return { handled: true, pathname: url.pathname };
    }

    return { handled: false, pathname: url.pathname };
  }

  return {
    config,
    actorFromRequest,
    actorFromSession,
    roleFromRequest,
    close: () => proxyDispatcher?.close() ?? Promise.resolve(),
    handle,
    trustedOrigin: config.publicOrigin,
  };
}
