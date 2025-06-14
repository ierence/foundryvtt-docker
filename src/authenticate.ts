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
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { wrapper as axiosCookieJarSupport } from "axios-cookiejar-support";
import process from "process";

// Globals
let cookieJar: CookieJar;
let logger: winston.Logger;

// Constants
const BASE_URL = "https://foundryvtt.com";
const LOCAL_DOMAIN = "felddy.com";
const LOGIN_URL = `${BASE_URL}/auth/login/`;
const USERNAME_RE = /\/community\/(?<username>.+)/;

const HEADERS = {
  DNT: "1",
  Referer: BASE_URL,
  "Upgrade-Insecure-Requests": "1",
  "User-Agent": "node-fetch",
};

// Setup axios with cookie jar support
afterMainSetup();
function afterMainSetup() {
  axiosCookieJarSupport(axios);
}

/**
 * axiosWithTimeout - Helper to use axios with cookie jar and timeout.
 */
async function axiosWithTimeout(
  config: AxiosRequestConfig,
  timeoutMs: number
): Promise<AxiosResponse> {
  config.jar = cookieJar;
  config.withCredentials = true;
  config.timeout = timeoutMs;
  return axios(config);
}

/**
 * fetchTokens - Retrieve CSRF token with manual timeout.
 */
async function fetchTokens(timeoutMs = 120_000): Promise<string> {
  logger.info(`Requesting CSRF tokens from ${BASE_URL}`);
  logger.debug(`Fetching: ${BASE_URL}`);

  const response = await axiosWithTimeout({
    url: BASE_URL,
    method: "GET",
    headers: HEADERS,
  }, timeoutMs);
  const $ = cheerio.load(response.data);
  const token = $('input[name="csrfmiddlewaretoken"]').val();
  if (!token) {
    throw new Error("Missing CSRF token in form");
  }
  return token as string;
}

/**
 * login - Authenticate and retrieve the community username.
 */
async function login(
  csrfmiddlewaretoken: string,
  username: string,
  password: string,
  timeoutMs = 120_000
): Promise<string> {
  logger.info(`Logging in as ${username}`);
  logger.debug(`Posting to: ${LOGIN_URL}`);

  const form = new URLSearchParams({ csrfmiddlewaretoken, next: "/", username, password });
  const response = await axiosWithTimeout({
    url: LOGIN_URL,
    method: "POST",
    headers: HEADERS,
    data: form,
    maxRedirects: 0,
    validateStatus: status => status >= 200 && status < 400, // allow 302 etc.
  }, timeoutMs);
  const $ = cheerio.load(response.data);

  // Verify session cookie
  const cookies = cookieJar.getCookiesSync(BASE_URL);
  if (!cookies.find(c => c.key === "sessionid")) {
    throw new Error("Session cookie missing; check credentials");
  }

  const communityURL = $("#login-welcome a").attr("href");
  if (!communityURL) {
    throw new Error("Community URL not found after login");
  }
  const match = communityURL.match(USERNAME_RE);
  if (!match?.groups?.username) {
    throw new Error(`Cannot parse username from ${communityURL}`);
  }
  return match.groups.username.toLowerCase();
}

/**
 * main - CLI entrypoint
 */
async function main(): Promise<number> {
  const options = docopt.docopt(doc, { version: "1.0.0" });
  const [user, passw, jar] = [options["<username>"], options["<password>"], options["<cookiejar>"]];
  HEADERS["User-Agent"] = options["--user-agent"];
  logger = createLogger("Authenticate", options["--log-level"].toLowerCase());

  cookieJar = new CookieJar(new FileCookieStore(jar));

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
