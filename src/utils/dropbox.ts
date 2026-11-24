import { Dropbox, DropboxAuth } from "dropbox";

const CLIENT_ID = "m8vpwemeau3ud7u";
const REDIRECT_URI = window.location.origin + window.location.pathname;

const ACCESS_TOKEN_KEY = "dropbox_access_token";
const REFRESH_TOKEN_KEY = "dropbox_refresh_token";
const EXPIRES_AT_KEY = "dropbox_expires_at";
const PKCE_VERIFIER_KEY = "dropbox_pkce_verifier";
const LEGACY_TOKEN_KEY = "dropbox_token";

export class DropboxAuthError extends Error {
  constructor(message = "Dropbox authentication expired or disconnected.") {
    super(message);
    this.name = "DropboxAuthError";
  }
}

interface TokenResponseResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

let pendingRedirectExchange: Promise<boolean> | null = null;

export const clearDropboxAuth = () => {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
  localStorage.removeItem(PKCE_VERIFIER_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
};

export const isDropboxConnected = (): boolean => {
  return Boolean(localStorage.getItem(REFRESH_TOKEN_KEY));
};

// Start OAuth 2.0 PKCE flow with offline access (gives a long-lived refresh token)
export const startDropboxAuth = async () => {
  const dbxAuth = new DropboxAuth({ clientId: CLIENT_ID });

  try {
    const authUrl = await dbxAuth.getAuthenticationUrl(
      REDIRECT_URI,
      undefined,
      "code",
      "offline",
      undefined,
      undefined,
      true,
    );

    const verifier = dbxAuth.getCodeVerifier();
    if (verifier) {
      localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    }

    window.location.href = authUrl.toString();
  } catch (error) {
    console.error("Failed to start Dropbox auth:", error);
    alert("Could not start Dropbox login.");
  }
};

// Complete OAuth redirect if ?code= is in URL (guarded against React StrictMode double-runs)
export const initDropboxAuth = async (): Promise<boolean> => {
  if (pendingRedirectExchange) {
    return pendingRedirectExchange;
  }

  pendingRedirectExchange = (async () => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");

    if (oauthError) {
      url.searchParams.delete("error");
      url.searchParams.delete("error_description");
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      localStorage.removeItem(PKCE_VERIFIER_KEY);
      return isDropboxConnected();
    }

    if (!code) {
      // Remove legacy short-lived token so users upgrade once to refresh tokens
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      return isDropboxConnected();
    }

    const verifier = localStorage.getItem(PKCE_VERIFIER_KEY);
    if (!verifier) {
      url.searchParams.delete("code");
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      return isDropboxConnected();
    }

    try {
      const dbxAuth = new DropboxAuth({ clientId: CLIENT_ID });
      dbxAuth.setCodeVerifier(verifier);

      const response = await dbxAuth.getAccessTokenFromCode(REDIRECT_URI, code);
      const tokenData = response.result as unknown as TokenResponseResult;

      if (!tokenData?.access_token || !tokenData?.refresh_token) {
        throw new Error("Missing access_token or refresh_token in Dropbox response.");
      }

      const expiresInMs = (tokenData.expires_in ?? 14400) * 1000;
      localStorage.setItem(ACCESS_TOKEN_KEY, tokenData.access_token);
      localStorage.setItem(REFRESH_TOKEN_KEY, tokenData.refresh_token);
      localStorage.setItem(EXPIRES_AT_KEY, String(Date.now() + expiresInMs));
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      localStorage.removeItem(PKCE_VERIFIER_KEY);

      url.searchParams.delete("code");
      url.searchParams.delete("state");
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);

      return true;
    } catch (error) {
      console.error("Dropbox token exchange failed:", error);
      clearDropboxAuth();
      url.searchParams.delete("code");
      url.searchParams.delete("state");
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      return false;
    }
  })();

  try {
    return await pendingRedirectExchange;
  } finally {
    pendingRedirectExchange = null;
  }
};

// Returns an authenticated Dropbox client, refreshing the access token automatically when needed
export const getDropboxClient = async (): Promise<Dropbox> => {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    clearDropboxAuth();
    throw new DropboxAuthError("Not connected to Dropbox.");
  }

  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY) || "";
  const expiresAtMs = Number(localStorage.getItem(EXPIRES_AT_KEY) || "0");

  const dbxAuth = new DropboxAuth({ clientId: CLIENT_ID });
  dbxAuth.setRefreshToken(refreshToken);

  if (accessToken && expiresAtMs > 0) {
    dbxAuth.setAccessToken(accessToken);
    // Force refresh if expiring within 5 minutes so mid-sync requests don't hit 401
    const effectiveExpiresAt =
      Date.now() >= expiresAtMs - 5 * 60 * 1000
        ? Date.now() - 1000
        : expiresAtMs;
    dbxAuth.setAccessTokenExpiresAt(new Date(effectiveExpiresAt));
  } else {
    dbxAuth.setAccessTokenExpiresAt(new Date(Date.now() - 1000));
  }

  try {
    await dbxAuth.checkAndRefreshAccessToken();
  } catch (error: any) {
    console.error("Failed to refresh Dropbox access token:", error);
    const status = error?.status;
    if (status === 400 || status === 401) {
      clearDropboxAuth();
      throw new DropboxAuthError("Dropbox session expired. Please reconnect Dropbox.");
    }
    throw error;
  }

  const latestAccessToken = dbxAuth.getAccessToken();
  const latestExpiresAt = dbxAuth.getAccessTokenExpiresAt();
  const latestRefreshToken = dbxAuth.getRefreshToken();

  if (latestAccessToken) {
    localStorage.setItem(ACCESS_TOKEN_KEY, latestAccessToken);
  }
  if (latestRefreshToken) {
    localStorage.setItem(REFRESH_TOKEN_KEY, latestRefreshToken);
  }
  if (latestExpiresAt instanceof Date && !Number.isNaN(latestExpiresAt.getTime())) {
    localStorage.setItem(EXPIRES_AT_KEY, String(latestExpiresAt.getTime()));
  }

  return new Dropbox({ auth: dbxAuth });
};

export const disconnectDropbox = async () => {
  try {
    if (isDropboxConnected()) {
      const dbx = await getDropboxClient();
      await dbx.authTokenRevoke();
    }
  } catch (error) {
    console.warn("Dropbox revoke failed (clearing local session anyway):", error);
  } finally {
    clearDropboxAuth();
  }
};