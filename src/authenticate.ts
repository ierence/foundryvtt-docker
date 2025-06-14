#!/usr/bin/env node

const doc = `
Log into Foundry Virtual Tabletop website, and save cookies to file.

EXIT STATUS
    This utility exits with one of the following values:
    0   Login completed successfully.
    >0  An error occurred.

Usage:
  authenticate.js [options] <username> <password> <cookiejar>
  authenticate.js (-h | --help)

Options:
  -h --help              Show this message.
  --log-level=LEVEL      If specified, then the log level will be set to
                         the specified value.  Valid values are "debug", "info",
                         "warn", and "error". [default: info]
  --user-agent=USERAGENT If specified, then the user-agent header will be set to
                         the specified value. [default: node-fetch]
`;

// Imports
import { CookieJar, Cookie } from "tough-cookie";
import { FileCookieStore } from "tough-cookie-file-store";
import * as cheerio from "cheerio";
import createLogger from "./logging.js";
import winston from "winston";
import docopt from "docopt";
import fetchCookie from "fetch-cookie";
import nodeFetch, { Headers } from "node-fetch";
import process from "process";

// Setup globals, to be configured in main()
let cookieJar: CookieJar;
let fetch: typeof nodeFetch;
let logger: winston.Logger;

// Constants
const BASE_URL = "https://foundryvtt.com";
const LOCAL_DOMAIN = "felddy.com";
const LOGIN_URL = `${BASE_URL}/auth/login/`;
const USERNAME_RE = /\/community\/(?<username>.+)/;

const HEADERS: Headers = new Headers({
  DNT: "1",
  Referer: BASE_URL,
  "Upgrade-Insecure-Requests": "1",
  "User-Agent": "node-fetch",
});

/**
 * fetchTokens - Fetch the CSRF form and cookie tokens.
 * @return {Promise<string>} CSRF token extracted from the login form.
 */
async function fetchTokens(): Promise<string> {
  logger.info(`Requesting CSRF tokens from ${BASE_URL}`);
  logger.debug(`Fetching: ${BASE_URL}`);

  // 60-second timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(BASE_URL, {
      method: "GET",
      headers: HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Unexpected response ${response.statusText}`);
    }
    const body = await response.text();
    const $ = cheerio.load(body);
    const token = $('input[name="csrfmiddlewaretoken"]').val();
    if (!token) {
      logger.error("Could not find the CSRF middleware token.");
      throw new Error("Missing CSRF token");
    }
    return token as string;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * login - Authenticate and retrieve the session username.
 */
async function login(
  csrfmiddlewaretoken: string,
  username: string,
  password: string
): Promise<string> {
  const form = new URLSearchParams({
    csrfmiddlewaretoken,
    next: "/",
    username,
    password,
  });

  logger.info(`Logging in as ${username}`);
  logger.debug(`Posting to: ${LOGIN_URL}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(LOGIN_URL, {
      method: "POST",
      headers: HEADERS,
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Login failed: ${response.statusText}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);

    const cookies = cookieJar.getCookiesSync(BASE_URL);
    if (!cookies.find(c => c.key === "sessionid")) {
      throw new Error("No session cookie - invalid credentials?");
    }

    const communityURL = $("#login-welcome a").attr("href");
    if (!communityURL) {
      throw new Error("Could not locate community URL after login");
    }
    const match = communityURL.match(USERNAME_RE);
    if (!match?.groups?.username) {
      throw new Error(`Unable to parse username from ${communityURL}`);
    }
    return match.groups.username.toLowerCase();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function main(): Promise<number> {
  const options = docopt.docopt(doc, { version: "1.0.0" });
  const [user, passw, jar] = [
    options["<username>"],
    options["<password>"],
    options["<cookiejar>"],
  ];
  HEADERS.set("User-Agent", options["--user-agent"]);
  logger = createLogger("Authenticate", options["--log-level"].toLowerCase());

  cookieJar = new CookieJar(new FileCookieStore(jar));
  fetch = fetchCookie(nodeFetch, cookieJar);

  try {
    const token = await fetchTokens();
    const actualUser = await login(token, user.toLowerCase(), passw);
    const cookie = Cookie.parse(`username=${actualUser}; Domain=${LOCAL_DOMAIN}; Path=/`)!;
    cookieJar.setCookieSync(cookie.toString(), `http://${LOCAL_DOMAIN}`);
    return 0;
  } catch (err: any) {
    logger.error(`Authentication error: ${err.message}`);
    return 1;
  }
}

(async () => {
  process.exitCode = await main();
})();
