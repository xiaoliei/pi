import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeEndpointEntry } from "../src/core/endpoint-config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ConnectDialogComponent } from "../src/modes/interactive/components/connect-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const BACKSPACE = "\x7f";
const ESCAPE = "\x1b";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function createFakeModelRuntime(modelsPath: string): ModelRuntime {
	return {
		getModelsPath: () => modelsPath,
		refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }),
	} as unknown as ModelRuntime;
}

function renderedText(dialog: ConnectDialogComponent): string {
	return stripAnsi(dialog.render(120).join("\n"));
}

/** Row containing the arrow marker for the current selection. */
function selectedRow(dialog: ConnectDialogComponent): string | undefined {
	return renderedText(dialog)
		.split("\n")
		.find((line) => line.trimStart().startsWith("→"));
}

function keypress(dialog: ConnectDialogComponent, key: string): void {
	dialog.handleInput(key);
}

describe("ConnectDialogComponent", () => {
	let tempDir: string;
	let modelsPath: string;

	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	async function createDialog(): Promise<ConnectDialogComponent> {
		tempDir = mkdtempSync(join(tmpdir(), "pi-connect-dialog-"));
		modelsPath = join(tempDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		await writeEndpointEntry(
			modelsPath,
			{ id: "alpha", name: "Alpha", baseUrl: "https://alpha.example.com/v1", api: "openai-completions" },
			[{ id: "m1", enabled: true, reasoning: false, contextWindow: 8192, maxTokens: 4096, input: ["text"] }],
		);
		await writeEndpointEntry(
			modelsPath,
			{ id: "beta", name: "Beta", baseUrl: "https://beta.example.com/v1", api: "anthropic-messages" },
			[{ id: "m2", enabled: true, reasoning: false, contextWindow: 8192, maxTokens: 4096, input: ["text"] }],
		);
		const dialog = new ConnectDialogComponent(createFakeTui(), {
			modelRuntime: createFakeModelRuntime(modelsPath),
			onClose: () => {},
			onChanged: () => {},
			onStatus: () => {},
			onError: () => {},
		});
		await dialog.open();
		return dialog;
	}

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		tempDir = undefined as unknown as string;
	});

	it("renders the input field only once on input pages", async () => {
		const dialog = await createDialog();
		// Enter add wizard: select "＋ Add endpoint" (last row)
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, ENTER);
		const text = renderedText(dialog);
		const promptCount = text.split("> ").length - 1;
		expect(promptCount).toBe(1);
	});

	it("shows a single input whose content matches what the user typed", async () => {
		const dialog = await createDialog();
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, ENTER);
		keypress(dialog, "h");
		keypress(dialog, "i");
		const text = renderedText(dialog);
		expect(text).toContain("hi");
		// exactly one "> " prompt line across the whole dialog
		expect(text.split("> ").length - 1).toBe(1);
	});

	it("deletes an endpoint after navigating to Delete and confirming", async () => {
		const dialog = await createDialog();
		// manage alpha
		keypress(dialog, ENTER);
		// move to "Delete endpoint" (index 4)
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, ENTER);
		// confirm-delete page: arrow must track selection
		expect(selectedRow(dialog)?.trim()).toBe("→ Delete");
		keypress(dialog, DOWN);
		expect(selectedRow(dialog)?.trim()).toBe("→ Cancel");
		keypress(dialog, UP);
		expect(selectedRow(dialog)?.trim()).toBe("→ Delete");
		keypress(dialog, ENTER);
		// deletion is async (void this.confirm()) — wait for it to land
		await vi.waitFor(() => {
			const stored = JSON.parse(readFileSync(modelsPath, "utf-8")) as { providers: Record<string, unknown> };
			expect(stored.providers["alpha"]).toBeUndefined();
		});
		await vi.waitFor(() => {
			const text = renderedText(dialog);
			expect(text).toContain("beta");
			expect(text).not.toContain("alpha.example.com");
		});
		const stored = JSON.parse(readFileSync(modelsPath, "utf-8")) as { providers: Record<string, unknown> };
		expect(stored.providers["beta"]).toBeDefined();
	});

	it("keeps the arrow following up/down on the models page", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage alpha
		keypress(dialog, DOWN);
		keypress(dialog, ENTER); // models page
		expect(selectedRow(dialog)).toContain("m1");
		keypress(dialog, DOWN);
		expect(selectedRow(dialog)).toContain("Add model");
		keypress(dialog, DOWN);
		expect(selectedRow(dialog)).toContain("Back");
		keypress(dialog, UP);
		expect(selectedRow(dialog)).toContain("Add model");
	});

	it("space toggles a model enabled and writes models.json", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage alpha
		keypress(dialog, DOWN);
		keypress(dialog, ENTER); // models page, arrow on m1
		keypress(dialog, SPACE);
		await vi.waitFor(() => {
			const stored = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
				providers: { alpha?: { models?: Array<{ id: string; enabled?: boolean }> } };
			};
			expect(stored.providers["alpha"]?.models?.[0]?.enabled).toBe(false);
		});
		await vi.waitFor(() => {
			expect(renderedText(dialog)).toContain("[ ] m1");
		});
		// Enter on a model row must not toggle anymore: it opens the edit menu.
		keypress(dialog, ENTER);
		expect(renderedText(dialog)).toContain("Edit model");
	});

	it("enter opens the per-field edit menu with current values", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage alpha
		keypress(dialog, DOWN);
		keypress(dialog, ENTER); // models page
		keypress(dialog, ENTER); // edit menu for m1
		const text = renderedText(dialog);
		expect(text).toContain("Edit model");
		expect(text).toContain("m1");
		expect(text).toContain("Context window:");
		expect(text).toContain("8192");
		expect(text).toContain("Back");
	});

	it("edits a text field (contextWindow) and persists it", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage alpha
		keypress(dialog, DOWN);
		keypress(dialog, ENTER); // models page
		keypress(dialog, ENTER); // edit menu
		// select Context window (index 5 of MODEL_EDIT_FIELDS)
		for (let i = 0; i < 5; i++) keypress(dialog, DOWN);
		keypress(dialog, ENTER);
		expect(renderedText(dialog)).toContain("Context window (tokens)");
		// clear the prefilled "8192" and type 4096
		for (let i = 0; i < 4; i++) keypress(dialog, BACKSPACE);
		for (const ch of "4096") keypress(dialog, ch);
		keypress(dialog, ENTER);
		await vi.waitFor(() => {
			const stored = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
				providers: { alpha?: { models?: Array<{ id: string; contextWindow?: number }> } };
			};
			expect(stored.providers["alpha"]?.models?.[0]?.contextWindow).toBe(4096);
		});
		// back on the edit menu with the new value shown
		await vi.waitFor(() => {
			expect(renderedText(dialog)).toContain("4096");
			expect(renderedText(dialog)).toContain("Edit model");
		});
	});

	it("rejects an invalid context window and keeps the field page", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage alpha
		keypress(dialog, DOWN);
		keypress(dialog, ENTER); // models page
		keypress(dialog, ENTER); // edit menu
		for (let i = 0; i < 5; i++) keypress(dialog, DOWN);
		keypress(dialog, ENTER); // contextWindow field
		for (let i = 0; i < 4; i++) keypress(dialog, BACKSPACE);
		keypress(dialog, "0");
		keypress(dialog, ENTER);
		await vi.waitFor(() => {
			const stored = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
				providers: { alpha?: { models?: Array<{ contextWindow?: number }> } };
			};
			expect(stored.providers["alpha"]?.models?.[0]?.contextWindow).toBe(8192);
		});
		expect(renderedText(dialog)).toContain("Context window");
	});

	it("toggles the reasoning choice field and persists it", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage alpha
		keypress(dialog, DOWN);
		keypress(dialog, ENTER); // models page
		keypress(dialog, ENTER); // edit menu
		// Reasoning is field index 2
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, ENTER);
		// syncSelection points the arrow at the current value ("No", index 1)
		expect(selectedRow(dialog)?.trim()).toBe("→ No");
		keypress(dialog, UP); // "Yes"
		keypress(dialog, ENTER);
		await vi.waitFor(() => {
			const stored = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
				providers: { alpha?: { models?: Array<{ reasoning?: boolean }> } };
			};
			expect(stored.providers["alpha"]?.models?.[0]?.reasoning).toBe(true);
		});
		await vi.waitFor(() => {
			expect(renderedText(dialog)).toContain("Edit model");
			expect(renderedText(dialog)).toContain("Reasoning:");
			expect(renderedText(dialog)).toContain("yes");
		});
	});

	it("esc from the field page returns to the edit menu", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage alpha
		keypress(dialog, DOWN);
		keypress(dialog, ENTER); // models page
		keypress(dialog, ENTER); // edit menu
		keypress(dialog, ENTER); // id field (index 0)
		expect(renderedText(dialog)).toContain("Model id");
		keypress(dialog, ESCAPE);
		expect(renderedText(dialog)).toContain("Edit model");
		// arrow restored to the field we came from
		expect(selectedRow(dialog)).toContain("Id:");
	});

	it("changing the model id rewrites the entry", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage alpha
		keypress(dialog, DOWN);
		keypress(dialog, ENTER); // models page
		keypress(dialog, ENTER); // edit menu
		keypress(dialog, ENTER); // id field
		for (let i = 0; i < 2; i++) keypress(dialog, BACKSPACE); // "m1" -> ""
		for (const ch of "m9") keypress(dialog, ch);
		keypress(dialog, ENTER);
		await vi.waitFor(() => {
			const stored = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
				providers: { alpha?: { models?: Array<{ id: string }> } };
			};
			expect(stored.providers["alpha"]?.models?.[0]?.id).toBe("m9");
		});
	});

	it("arrow follows movement on the confirm-delete page entered via Esc", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage
		for (let i = 0; i < 4; i++) keypress(dialog, DOWN);
		keypress(dialog, ENTER); // confirm-delete
		keypress(dialog, DOWN);
		expect(selectedRow(dialog)?.trim()).toBe("→ Cancel");
	});

	it("clamps selection to the last row on selection pages", async () => {
		const dialog = await createDialog();
		for (let i = 0; i < 10; i++) keypress(dialog, DOWN);
		expect(selectedRow(dialog)).toContain("＋ Add endpoint");
	});
});
