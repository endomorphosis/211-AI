import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.ABBY_CAPTURE_BASE_URL || "http://127.0.0.1:4177/";
const outputDir = path.resolve(process.cwd(), "artifacts", "live-review-headless");
const sessionKey = "abby-ui-session-v1";
const sessionValue = JSON.stringify({ username: "demo-user" });

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
	viewport: { width: 1440, height: 2200 },
	deviceScaleFactor: 1,
});

try {
	await context.addInitScript(
		({ key, value }) => {
			window.localStorage.setItem(key, value);
		},
		{ key: sessionKey, value: sessionValue },
	);

	const page = await context.newPage();
	await page.goto(baseUrl, { waitUntil: "networkidle" });
	await page.screenshot({ path: path.join(outputDir, "shell-home-desktop-full.png"), fullPage: true });

	const pageSize = await page.evaluate(() => ({
		width: document.documentElement.clientWidth,
		height: document.documentElement.scrollHeight,
	}));
	const shellRects = await page.evaluate(() => {
		function toRect(selector, fallback) {
			const element = document.querySelector(selector);
			if (!element) return fallback;
			const rect = element.getBoundingClientRect();
			return {
				x: Math.max(0, Math.floor(rect.left)),
				y: Math.max(0, Math.floor(rect.top + window.scrollY)),
				width: Math.max(1, Math.ceil(rect.width)),
				height: Math.max(1, Math.ceil(rect.height)),
			};
		}

		return {
			sidebar: toRect(".sidebar", { x: 0, y: 0, width: 320, height: 1400 }),
			hero: toRect(".home-hero", { x: 300, y: 80, width: 1040, height: 280 }),
		};
	});
	await page.screenshot({
		path: path.join(outputDir, "shell-sidebar-desktop.png"),
		clip: shellRects.sidebar,
	});
	await page.screenshot({
		path: path.join(outputDir, "shell-header-desktop.png"),
		clip: shellRects.hero,
	});
	await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
	await page.waitForTimeout(300);
	await page.screenshot({
		path: path.join(outputDir, "shell-home-footer-desktop.png"),
		clip: {
			x: 0,
			y: Math.max(0, pageSize.height - 420),
			width: pageSize.width,
			height: Math.min(420, pageSize.height),
		},
	});

	await page.goto(`${baseUrl}#social-services`, { waitUntil: "networkidle" });
	await page.screenshot({ path: path.join(outputDir, "shell-social-services-desktop-full.png"), fullPage: true });

	console.log(JSON.stringify({
		ok: true,
		baseUrl,
		outputDir,
		files: [
			"shell-home-desktop-full.png",
			"shell-sidebar-desktop.png",
			"shell-header-desktop.png",
			"shell-home-footer-desktop.png",
			"shell-social-services-desktop-full.png",
		],
	}, null, 2));
} finally {
	await context.close();
	await browser.close();
}
