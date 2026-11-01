import assert from "node:assert/strict";
import test from "node:test";
import thinkingMessagingExtension, {
	IDLE_NOTICE,
	IDLE_PROBABLY_IDLE_NOTICE,
	IDLE_TAKING_A_WHILE_NOTICE,
} from "../src/index.ts";

function createSession() {
	type API = Parameters<typeof thinkingMessagingExtension>[0];
	type Context = Parameters<Parameters<API["on"]>[1]>[1];
	type Handler = (event: any, ctx: Context) => void;
	const handlers = new Map<Parameters<API["on"]>[0], Handler>();
	let message: string | undefined;
	const ctx = {
		ui: {
			setWorkingMessage: (value?: string) => { message = value; },
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
		},
	};
	thinkingMessagingExtension({ on: (name, handler) => { handlers.set(name, handler); } });
	return {
		emit: (name: Parameters<API["on"]>[0], event: unknown = {}) => handlers.get(name)?.(event, ctx),
		message: () => message ?? "",
	};
}

test("advances all idle stages while a provider request is silent, then recovers on tokens", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const session = createSession();
	t.after(() => session.emit("session_shutdown"));
	session.emit("session_start");
	session.emit("agent_start");
	session.emit("before_provider_request", { payload: {} });

	for (const [time, notice] of [
		[61_000, IDLE_TAKING_A_WHILE_NOTICE],
		[181_000, IDLE_PROBABLY_IDLE_NOTICE],
		[301_000, IDLE_NOTICE],
	] as const) {
		t.mock.timers.tick(time - Date.now());
		assert.ok(session.message().includes(notice), session.message());
	}

	session.emit("message_update", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "hello" }] },
		assistantMessageEvent: { type: "thinking_delta", delta: "hello" },
	});
	assert.match(session.message(), /^Thinking/);
	assert.doesNotMatch(session.message(), /agent is/);
	t.mock.timers.tick(301_000);
	assert.ok(session.message().includes(IDLE_NOTICE));
	session.emit("agent_end");
	t.mock.timers.tick(301_000);
	assert.equal(session.message(), "");
});

test("shows tool wait beyond five minutes, then resumes token-idle monitoring", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const session = createSession();
	t.after(() => session.emit("session_shutdown"));
	session.emit("before_agent_start", { prompt: "test" });
	session.emit("agent_start");
	t.mock.timers.tick(10_000);
	session.emit("tool_execution_start", { toolCallId: "test", toolName: "bash", args: {} });
	assert.equal(session.message(), "Waiting for tools… (10s · ↑ 1 tokens · tool wait 0s)");
	t.mock.timers.tick(301_000);
	assert.equal(session.message(), "Waiting for tools… (5m 11s · ↑ 1 tokens · tool wait 5m 1s)");

	session.emit("tool_execution_end", { toolCallId: "test", toolName: "bash", result: {}, isError: false });
	assert.match(session.message(), /^Working/);
	assert.ok(session.message().includes(IDLE_NOTICE), session.message());
	session.emit("before_provider_request", { payload: {} });
	assert.equal(session.message(), "Working… (5m 11s · ↑ 1 tokens)");
	t.mock.timers.tick(61_000);
	assert.ok(session.message().includes(IDLE_TAKING_A_WHILE_NOTICE), session.message());
});

for (const firstFinished of ["older", "newer"]) {
	test(`tracks overlapping calls by ID when ${firstFinished} finishes first`, (t) => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
		const session = createSession();
		t.after(() => session.emit("session_shutdown"));
		session.emit("agent_start");
		session.emit("tool_execution_start", { toolCallId: "older", toolName: "bash", args: {} });
		t.mock.timers.tick(100_000);
		session.emit("tool_execution_start", { toolCallId: "newer", toolName: "bash", args: {} });
		t.mock.timers.tick(201_000);
		assert.match(session.message(), /tool wait 5m 1s/);
		session.emit("tool_execution_end", { toolCallId: firstFinished, toolName: "bash", result: {}, isError: true });
		assert.match(session.message(), /^Waiting for tools/);
		assert.match(session.message(), firstFinished === "older" ? /tool wait 3m 21s/ : /tool wait 5m 1s/);
		t.mock.timers.tick(1_000);
		assert.match(session.message(), firstFinished === "older" ? /tool wait 3m 22s/ : /tool wait 5m 2s/);
		session.emit("tool_execution_end", {
			toolCallId: firstFinished === "older" ? "newer" : "older", toolName: "bash", result: {}, isError: false,
		});
		assert.match(session.message(), /^Working/);
		assert.ok(session.message().includes(IDLE_NOTICE), session.message());
	});
}

for (const cleanup of ["agent_end", "session_start", "session_shutdown", "agent_start"] as const) {
	test(`clears outstanding tools on ${cleanup}`, (t) => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
		const session = createSession();
		t.after(() => session.emit("session_shutdown"));
		session.emit("agent_start");
		session.emit("tool_execution_start", { toolCallId: "aborted", toolName: "bash", args: {} });
		assert.match(session.message(), /^Waiting for tools/);
		// Aborting a run still ends it via agent_end; no tool completion is required for cleanup.
		session.emit(cleanup);
		if (cleanup !== "agent_start") {
			t.mock.timers.tick(1_000);
			assert.equal(session.message(), "");
			session.emit("agent_start");
		}
		assert.equal(session.message(), "Working… (0s · ↑ 0 tokens)");
		t.mock.timers.tick(301_000);
		assert.ok(session.message().includes(IDLE_NOTICE), session.message());
	});
}

test("keeps tool waits instance-local even with matching call IDs", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const lead = createSession();
	const child = createSession();
	t.after(() => { lead.emit("session_shutdown"); child.emit("session_shutdown"); });
	lead.emit("agent_start");
	child.emit("agent_start");
	lead.emit("tool_execution_start", { toolCallId: "same", toolName: "bash", args: {} });
	t.mock.timers.tick(301_000);
	assert.match(lead.message(), /tool wait 5m 1s/);
	assert.ok(child.message().includes(IDLE_NOTICE), child.message());
	child.emit("tool_execution_start", { toolCallId: "same", toolName: "bash", args: {} });
	assert.match(child.message(), /tool wait 0s/);
	child.emit("tool_execution_end", { toolCallId: "same", toolName: "bash", result: {}, isError: false });
	child.emit("session_shutdown");
	t.mock.timers.tick(1_000);
	assert.match(lead.message(), /tool wait 5m 2s/);
	lead.emit("tool_execution_end", { toolCallId: "same", toolName: "bash", result: {}, isError: false });
	assert.ok(lead.message().includes(IDLE_NOTICE), lead.message());
});

test("another session's lifecycle cannot cancel the lead's idle warning", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const lead = createSession();
	const child = createSession();
	t.after(() => { lead.emit("session_shutdown"); child.emit("session_shutdown"); });
	lead.emit("session_start");
	lead.emit("agent_start");
	t.mock.timers.tick(30_000);
	child.emit("session_start");
	child.emit("agent_start");
	child.emit("before_provider_request", { payload: {} });
	child.emit("agent_end");
	child.emit("session_shutdown");
	t.mock.timers.tick(271_000);
	assert.ok(lead.message().includes(IDLE_NOTICE), lead.message());
	assert.match(lead.message(), /5m 1s/);
});

test("a busy child does not reset the lead's inactivity clock or token count", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const lead = createSession();
	const child = createSession();
	t.after(() => { lead.emit("session_shutdown"); child.emit("session_shutdown"); });
	lead.emit("session_start");
	lead.emit("before_agent_start", { prompt: "lead" });
	child.emit("session_start");
	child.emit("before_agent_start", { prompt: "child prompt" });
	lead.emit("agent_start");
	child.emit("agent_start");
	t.mock.timers.tick(300_000);
	child.emit("before_provider_request", { payload: {} });
	t.mock.timers.tick(1_000);
	assert.ok(lead.message().includes(IDLE_NOTICE), lead.message());
	assert.match(lead.message(), /↑ 1 tokens/);
	assert.doesNotMatch(child.message(), /agent is/);
});
