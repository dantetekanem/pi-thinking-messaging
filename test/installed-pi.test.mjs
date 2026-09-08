import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import thinkingMessagingExtension, {
	IDLE_NOTICE, IDLE_PROBABLY_IDLE_NOTICE, IDLE_TAKING_A_WHILE_NOTICE,
} from "../src/index.ts";

// Explicitly target an installed Pi without adding or downloading dependencies.
assert.ok(process.env.PI_TEST_PACKAGE_DIR, "Set PI_TEST_PACKAGE_DIR to the installed pi-coding-agent package directory");
const root = resolve(process.env.PI_TEST_PACKAGE_DIR);
const sdk = await import(pathToFileURL(resolve(root, "dist/index.js")));
const ai = await import(pathToFileURL(resolve(root, "../pi-ai/dist/index.js")));
const codex = await import(pathToFileURL(resolve(root, "../pi-ai/dist/api/openai-codex-responses.js")));
const apiKey = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
const { initTheme } = await import(pathToFileURL(resolve(root, "dist/modes/interactive/theme/theme.js")));
const { createInteractiveTui } = await import(pathToFileURL(resolve(root, "dist/modes/interactive/tui-renderer.js")));
initTheme("dark");

for (const phase of ["waiting for response", "thinking started", "thinking tokens received"]) {
	test(`installed Pi/Codex shows idle warning while ${phase}, without any tool execution`, async (t) => {
		const runtime = await sdk.ModelRuntime.create({
			credentials: new ai.InMemoryCredentialStore(),
			modelsStore: new ai.InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		t.mock.method(runtime, "getAuth", async () => ({ auth: { apiKey } }));
		t.mock.method(runtime, "hasConfiguredAuth", () => true);
		const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new sdk.DefaultResourceLoader({
			cwd: process.cwd(), agentDir: process.cwd(), settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [thinkingMessagingExtension], systemPromptOverride: () => "Test",
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const model = {
			id: "idle-test", name: "Idle test", provider: "openai-codex", api: "openai-codex-responses",
			baseUrl: "https://unused.invalid", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000,
		};
		const { session } = await sdk.createAgentSession({
			modelRuntime: runtime, model, thinkingLevel: "high", tools: [], resourceLoader: loader,
			settingsManager, sessionManager: sdk.SessionManager.inMemory("/"),
		});
		const errors = [];
		const mode = new sdk.InteractiveMode({ session, setBeforeSessionInvalidate() {}, setRebindSession() {} }, { tuiMode: "regular" });
		const writes = [];
		let expectedNotice;
		let rendered;
		const terminal = {
			columns: 120, rows: 40, kittyProtocolActive: false,
			start() {}, stop() {}, async drainInput() {},
			write(data) {
				writes.push(data);
				if (expectedNotice && writes.join("").includes(expectedNotice)) rendered?.resolve();
			},
			moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
			clearScreen() {}, setTitle() {}, setProgress() {},
		};
		// Exercise real InteractiveMode handlers without starting a user's terminal or startup services.
		mode.renderer = createInteractiveTui({ tuiMode: "regular", terminal });
		mode.renderer.addChild(mode.statusContainer);
		mode.renderer.addChild(mode.editorContainer);
		mode.renderer.start();
		mode.isInitialized = true;
		mode.subscribeToAgent();
		await session.bindExtensions({ uiContext: mode.createExtensionUIContext(), mode: "tui", onError: (error) => errors.push(error) });
		t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
		const ready = Promise.withResolvers();
		const headers = Promise.withResolvers();
		let body;
		const response = new Response(new ReadableStream({ start(controller) { body = controller; } }), {
			headers: { "content-type": "text/event-stream" },
		});
		const send = (event) => body.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
		const fetch = t.mock.method(globalThis, "fetch", async () => {
			if (phase === "waiting for response") {
				ready.resolve();
				await headers.promise;
			} else {
				send({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r1", summary: [] } });
				if (phase === "thinking tokens received") send({
					type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Considering the problem",
				});
			}
			return response;
		});
		const events = [];
		let nextDelta;
		session.subscribe((event) => {
			events.push(event.type);
			if (event.type === "message_update") {
				if (event.assistantMessageEvent.type === "thinking_delta") nextDelta?.resolve();
				if (event.assistantMessageEvent.type ===
					(phase === "thinking started" ? "thinking_start" : "thinking_delta")) ready.resolve();
			}
		});
		// Keep Pi's real Codex request builder and SSE parser; replace only network/auth.
		t.mock.method(runtime, "streamSimple", (model, context, options) => codex.stream(model, context, {
			...options, apiKey, transport: "sse", maxRetries: 0,
		}));
		const prompt = session.prompt("Exercise a silent thinking stream");
		prompt.catch((error) => ready.reject(error));
		t.after(async () => {
			headers.resolve();
			send({ type: "response.completed", response: { id: "test", status: "completed", output: [] } });
			body.close();
			await prompt;
			mode.unsubscribe?.();
			mode.clearStatusIndicator();
			mode.renderer.stop();
			mode.footer.dispose();
			mode.footerDataProvider.dispose();
			session.dispose();
		});
		await ready.promise;
		assert.equal(session.isStreaming, true);
		assert.equal(fetch.mock.callCount(), 1);
		if (phase !== "waiting for response") assert.match(mode.workingMessage, /^Thinking/);
		assert.deepEqual(errors, []);
		for (const [time, notice] of [
			[61_000, IDLE_TAKING_A_WHILE_NOTICE],
			[181_000, IDLE_PROBABLY_IDLE_NOTICE],
			[301_000, IDLE_NOTICE],
		]) {
			writes.length = 0;
			expectedNotice = notice;
			rendered = Promise.withResolvers();
			t.mock.timers.tick(time - Date.now());
			assert.ok(mode.workingMessage.includes(notice), mode.workingMessage);
			assert.equal(mode.workingVisible, true);
			assert.equal(mode.activeStatusIndicator?.kind, "working");
			assert.equal(mode.renderer.stopped, false);
			assert.ok(mode.editor.render(120).join("\n").includes(notice));
			await rendered.promise;
			assert.ok(writes.join("").includes(notice), "Idle warning reaches terminal output without a provider event");
		}
		if (phase !== "waiting for response") {
			nextDelta = Promise.withResolvers();
			send({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "More reasoning" });
			await nextDelta.promise;
			assert.match(mode.workingMessage, /^Thinking/);
			assert.doesNotMatch(mode.workingMessage, /agent is/);
			t.mock.timers.tick(301_000);
			assert.ok(mode.editor.render(120).join("\n").includes(IDLE_NOTICE));
		}
		assert.equal(events.includes("tool_execution_start"), false);
		assert.equal(events.includes("agent_end"), false);
		assert.deepEqual(errors, []);
	});
}
