import { join } from "node:path";
import { type DiscoveredEndpointModel, discoverEndpointModels } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "@earendil-works/pi-tui";
import { getAgentDir } from "../../../config.ts";
import {
	deleteEndpointEntry,
	type EndpointApi,
	mergeDiscoveredModels,
	modelDefinitionsFromDiscovery,
	uniqueEndpointId,
	updateEndpointEntry,
	updateEndpointModels,
	writeEndpointEntry,
} from "../../../core/endpoint-config.ts";
import { ModelConfig, type ModelsJsonModel, type ModelsJsonProvider } from "../../../core/model-config.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

const ENDPOINT_APIS: EndpointApi[] = ["openai-completions", "openai-responses", "anthropic-messages"];

export interface ConnectDialogOptions {
	modelRuntime: ModelRuntime;
	/** Esc on the root list closes the dialog. */
	onClose: () => void;
	/** Called after a successful write + refresh. */
	onChanged: () => void | Promise<void>;
	onStatus: (message: string) => void;
	onError: (message: string) => void;
}

type Page =
	| { kind: "list" }
	| { kind: "manage"; id: string; entry: ModelsJsonProvider }
	| { kind: "edit"; id: string; entry: ModelsJsonProvider; step: number }
	| { kind: "add"; step: number; form: AddForm; busy?: string; error?: string; discovered?: DiscoveredEndpointModel[] }
	| { kind: "models"; id: string }
	| { kind: "model-form"; id: string; index: number; step: number; form: ModelForm }
	| { kind: "model-edit"; id: string; index: number }
	| { kind: "model-field"; id: string; index: number; field: ModelEditField }
	| { kind: "compat"; id: string; step: number; text: string; error?: string }
	| { kind: "confirm-delete"; id: string };

interface AddForm {
	id: string;
	baseUrl: string;
	name: string;
	apiKey: string;
	api: EndpointApi;
	headers: string;
	discover: boolean;
}

interface ModelForm {
	id: string;
	name: string;
	reasoning: boolean;
	enabled: boolean;
	input: "text" | "text+image";
	contextWindow: string;
	maxTokens: string;
}

const MODEL_INPUT_CHOICES = ["Text only", "Text + image"] as const;

type ModelEditField = "id" | "name" | "reasoning" | "enabled" | "input" | "contextWindow" | "maxTokens";

const MODEL_EDIT_FIELDS: readonly ModelEditField[] = [
	"id",
	"name",
	"reasoning",
	"enabled",
	"input",
	"contextWindow",
	"maxTokens",
];

function modelFieldLabel(field: ModelEditField): string {
	switch (field) {
		case "id":
			return "Id";
		case "name":
			return "Name";
		case "reasoning":
			return "Reasoning";
		case "enabled":
			return "Enabled";
		case "input":
			return "Input";
		case "contextWindow":
			return "Context window";
		case "maxTokens":
			return "Max tokens";
	}
}

function modelFieldValue(model: ModelsJsonModel, field: ModelEditField): string {
	switch (field) {
		case "id":
			return model.id;
		case "name":
			return model.name ?? "";
		case "reasoning":
			return model.reasoning ? "yes" : "no";
		case "enabled":
			return model.enabled !== false ? "yes" : "no";
		case "input":
			return model.input?.includes("image") ? "text + image" : "text";
		case "contextWindow":
			return String(model.contextWindow ?? "");
		case "maxTokens":
			return String(model.maxTokens ?? "");
	}
}

function isChoiceModelField(field: ModelEditField): field is "reasoning" | "enabled" | "input" {
	return field === "reasoning" || field === "enabled" || field === "input";
}

function modelChoiceIndex(model: ModelsJsonModel | undefined, field: "reasoning" | "enabled" | "input"): number {
	if (!model) return 0;
	if (field === "input") return model.input?.includes("image") ? 1 : 0;
	if (field === "reasoning") return model.reasoning ? 0 : 1;
	return model.enabled !== false ? 0 : 1;
}

function inputFromForm(form: ModelForm): ("text" | "image")[] {
	return form.input === "text+image" ? ["text", "image"] : ["text"];
}

function entryApi(entry: ModelsJsonProvider): EndpointApi {
	return entry.api === "openai-responses" || entry.api === "anthropic-messages" ? entry.api : "openai-completions";
}

function parseHeadersText(text: string): Record<string, string> | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const headers: Record<string, string> = {};
	for (const part of trimmed.split(",")) {
		const colon = part.indexOf(":");
		if (colon <= 0) throw new Error(`Invalid header "${part.trim()}" — expected "Name: value"`);
		const name = part.slice(0, colon).trim();
		const value = part.slice(colon + 1).trim();
		if (!name || !value) throw new Error(`Invalid header "${part.trim()}" — expected "Name: value"`);
		headers[name] = value;
	}
	return headers;
}

/**
 * /connect dialog: endpoint list, add wizard, and per-endpoint management
 * (edit basics, model list/enable, rediscover, compat, delete).
 */
export class ConnectDialogComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly options: ConnectDialogOptions;
	private readonly contentContainer: Container;
	private readonly input: Input;
	private page: Page = { kind: "list" };
	private selectedIndex = 0;
	private lastPageKey = "";
	private endpoints: Array<{ id: string; entry: ModelsJsonProvider }> = [];
	private discoveryController: AbortController | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(tui: TUI, options: ConnectDialogOptions) {
		super();
		this.tui = tui;
		this.options = options;

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Connect endpoints")), 1, 0));
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		this.input = new Input();
		this.addChild(new DynamicBorder());

		this.input.onEscape = () => {
			this.stepBack();
		};
	}

	private get modelsPath(): string {
		return this.options.modelRuntime.getModelsPath() ?? modelsJsonPath();
	}

	private async loadEndpoints(): Promise<void> {
		const config = await ModelConfig.load(this.modelsPath);
		const error = config.getError();
		if (error) {
			this.endpoints = [];
			this.showErrorPage(error);
			return;
		}
		this.endpoints = config
			.getProviderIds()
			.map((id) => ({ id, entry: config.getProvider(id)! }))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	private showErrorPage(message: string): void {
		this.page = { kind: "add", step: 99, form: emptyForm(), error: message };
		this.renderDialog();
	}

	async open(): Promise<void> {
		await this.loadEndpoints();
		this.lastPageKey = "";
		this.page = { kind: "list" };
		this.selectedIndex = 0;
		this.renderDialog();
	}

	private renderDialog(): void {
		this.syncSelection();
		this.contentContainer.clear();
		const page = this.page;
		this.contentContainer.addChild(new Spacer(1));
		if (page.kind === "list") {
			this.renderList();
		} else if (page.kind === "manage") {
			this.renderManage(page.id);
		} else if (page.kind === "add") {
			this.renderAdd(page);
		} else if (page.kind === "edit") {
			this.renderEdit(page);
		} else if (page.kind === "models") {
			this.renderModels(page.id);
		} else if (page.kind === "model-form") {
			this.renderModelForm(page);
		} else if (page.kind === "model-edit") {
			this.renderModelEdit(page);
		} else if (page.kind === "model-field") {
			this.renderModelField(page);
		} else if (page.kind === "compat") {
			this.renderCompat(page);
		} else if (page.kind === "confirm-delete") {
			this.renderConfirmDelete(page);
		}
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(
			new Text(theme.fg("dim", `(${keyHint("tui.select.cancel", "back/cancel")})`), 1, 0),
		);
		this.tui.requestRender();
	}

	private renderList(): void {
		const rows = this.endpoints.map(({ id, entry }) => {
			const count = entry.models?.length ?? 0;
			return `${id} — ${entry.name ?? id} · ${entry.baseUrl ?? ""} · ${entryApi(entry)} · ${count} model${count === 1 ? "" : "s"}`;
		});
		const lines = [...rows, "＋ Add endpoint"];
		this.renderSelectable("Select an endpoint to manage:", lines, this.selectedIndex);
	}

	private renderManage(id: string): void {
		const entry = this.endpoints.find((endpoint) => endpoint.id === id)?.entry;
		if (!entry) {
			this.page = { kind: "list" };
			this.renderDialog();
			return;
		}
		const count = entry.models?.length ?? 0;
		const lines = [
			`Edit endpoint (${entry.name ?? id})`,
			`Models (${count})`,
			"Rediscover models",
			"Edit compat",
			"Delete endpoint",
		];
		this.renderSelectable(`Endpoint: ${id}`, lines, this.selectedIndex);
	}

	private renderAdd(page: Extract<Page, { kind: "add" }>): void {
		if (page.error) {
			this.contentContainer.addChild(new Text(theme.fg("error", page.error), 1, 0));
			this.contentContainer.addChild(new Spacer(1));
		}
		if (page.busy) {
			this.contentContainer.addChild(new Text(theme.fg("dim", page.busy), 1, 0));
			return;
		}
		if (page.discovered) {
			this.contentContainer.addChild(
				new Text(
					theme.fg("text", `Found ${page.discovered.length} model(s). Adding endpoint "${page.form.id}"…`),
					1,
					0,
				),
			);
			return;
		}
		const step = page.step;
		const prompts: Array<{ title: string; prefill: string }> = [
			{ title: "Base URL (e.g. https://relay.example.com/v1)", prefill: page.form.baseUrl },
			{ title: "Endpoint id (auto-derived from host)", prefill: page.form.id },
			{ title: "Name", prefill: page.form.name },
			{ title: "API key (empty for keyless servers)", prefill: page.form.apiKey },
		];
		if (step < 4) {
			const prompt = prompts[step]!;
			this.renderInputStep(prompt.title, prompt.prefill);
			return;
		}
		if (step === 4) {
			this.renderSelectable("Protocol:", ENDPOINT_APIS, this.selectedIndex);
			return;
		}
		if (step === 5) {
			this.renderInputStep("Extra headers (Name: value, Name2: value2 — optional)", page.form.headers);
			return;
		}
		if (step === 6) {
			this.renderSelectable("Discover and import models via /models?", ["Yes", "No"], this.selectedIndex);
		}
	}

	private renderEdit(page: Extract<Page, { kind: "edit" }>): void {
		const entry = page.entry;
		const prompts: Array<{ title: string; prefill: string }> = [
			{ title: "Base URL", prefill: entry.baseUrl ?? "" },
			{ title: "Name", prefill: entry.name ?? page.id },
			{ title: "API key (empty to remove)", prefill: entry.apiKey ?? "" },
			{ title: "Extra headers (Name: value, ...)", prefill: formatHeaders(entry.headers) },
		];
		if (page.step < 4) {
			const prompt = prompts[page.step]!;
			this.renderInputStep(prompt.title, prompt.prefill);
			return;
		}
		if (page.step === 4) {
			this.renderSelectable("Protocol:", ENDPOINT_APIS, this.selectedIndex);
		}
	}

	private renderModels(id: string): void {
		const entry = this.endpoints.find((endpoint) => endpoint.id === id)?.entry;
		if (!entry) {
			this.page = { kind: "list" };
			this.renderDialog();
			return;
		}
		const modelLines = (entry.models ?? []).map((model) => {
			const enabled = model.enabled !== false ? "x" : " ";
			const meta = `${model.contextWindow ?? "?"}ctx/${model.maxTokens ?? "?"}max${model.reasoning ? " r" : ""}`;
			return `[${enabled}] ${model.id} (${meta})`;
		});
		const lines = [...modelLines, "＋ Add model", "Back"];
		this.renderSelectable(
			`Models for ${id} (${keyHint("app.connect.toggleModel", "toggles enabled")}, ${keyHint("tui.select.confirm", "edit")}):`,
			lines,
			this.selectedIndex,
		);
	}

	private renderModelForm(page: Extract<Page, { kind: "model-form" }>): void {
		const form = page.form;
		if (page.step === 0) {
			this.renderInputStep("Model id", form.id);
		} else if (page.step === 1) {
			this.renderInputStep("Name", form.name);
		} else if (page.step === 2) {
			this.renderSelectable("Reasoning:", ["Yes", "No"], this.selectedIndex);
		} else if (page.step === 3) {
			this.renderSelectable("Enabled:", ["Yes", "No"], this.selectedIndex);
		} else if (page.step === 4) {
			this.renderSelectable("Input:", [...MODEL_INPUT_CHOICES], this.selectedIndex);
		} else if (page.step === 5) {
			this.renderInputStep("Context window (tokens)", form.contextWindow);
		} else if (page.step === 6) {
			this.renderInputStep("Max tokens", form.maxTokens);
		}
	}

	private renderModelEdit(page: Extract<Page, { kind: "model-edit" }>): void {
		const model = this.currentEntry(page.id)?.models?.[page.index];
		if (!model) {
			this.page = { kind: "models", id: page.id };
			this.renderDialog();
			return;
		}
		const rows = MODEL_EDIT_FIELDS.map(
			(field) => `${`${modelFieldLabel(field)}:`.padEnd(16)} ${modelFieldValue(model, field)}`,
		);
		this.renderSelectable(`Edit model "${model.id}":`, [...rows, "Back"], this.selectedIndex);
	}

	private renderModelField(page: Extract<Page, { kind: "model-field" }>): void {
		const model = this.currentEntry(page.id)?.models?.[page.index];
		if (!model) {
			this.page = { kind: "models", id: page.id };
			this.renderDialog();
			return;
		}
		const field = page.field;
		if (isChoiceModelField(field)) {
			const choices = field === "input" ? [...MODEL_INPUT_CHOICES] : ["Yes", "No"];
			this.renderSelectable(`${modelFieldLabel(field)}:`, choices, this.selectedIndex);
			return;
		}
		const titles: Record<Exclude<ModelEditField, "reasoning" | "enabled" | "input">, string> = {
			id: "Model id",
			name: "Name (empty to clear)",
			contextWindow: "Context window (tokens)",
			maxTokens: "Max tokens",
		};
		this.renderInputStep(titles[field], modelFieldValue(model, field));
	}

	private renderCompat(page: Extract<Page, { kind: "compat" }>): void {
		if (page.error) {
			this.contentContainer.addChild(new Text(theme.fg("error", page.error), 1, 0));
			this.contentContainer.addChild(new Spacer(1));
		}
		this.contentContainer.addChild(
			new Text(theme.fg("text", "Compat overrides as JSON ({} to clear, Enter to save):"), 1, 0),
		);
		this.contentContainer.addChild(new Spacer(1));
		this.prepareInput(page.text);
	}

	private renderConfirmDelete(page: Extract<Page, { kind: "confirm-delete" }>): void {
		this.renderSelectable(
			`Delete endpoint "${page.id}"? This cannot be undone.`,
			["Delete", "Cancel"],
			this.selectedIndex,
		);
	}

	private renderSelectable(title: string, lines: readonly string[], selected: number): void {
		this.contentContainer.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			const rendered = index === selected ? theme.fg("accent", `→ ${line}`) : theme.fg("text", `  ${line}`);
			this.contentContainer.addChild(new TruncatedText(rendered, 1, 0));
		}
		this.contentContainer.addChild(new Spacer(1));
	}

	private renderInputStep(title: string, prefill: string): void {
		this.contentContainer.addChild(new Text(theme.fg("text", title), 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.prepareInput(prefill);
	}

	private prepareInput(value: string): void {
		this.input.setValue(value);
		this.input.onSubmit = () => {
			this.submitInput(this.input.getValue());
		};
		this.input.onEscape = () => {
			this.stepBack();
		};
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(new Text(theme.fg("dim", `(${keyHint("tui.select.confirm", "submit")})`), 1, 0));
	}

	private async submitInput(value: string): Promise<void> {
		const page = this.page;
		if (page.kind === "add") {
			await this.advanceAddStep(value);
		} else if (page.kind === "edit") {
			await this.advanceEditStep(value);
		} else if (page.kind === "model-form") {
			await this.advanceModelFormStep(value);
		} else if (page.kind === "model-field") {
			await this.submitModelField(value);
		} else if (page.kind === "compat") {
			await this.saveCompat(value);
		}
	}

	private async advanceAddStep(value: string): Promise<void> {
		const page = this.page;
		if (page.kind !== "add" || page.busy || page.discovered) return;
		const form = { ...page.form };
		try {
			switch (page.step) {
				case 0: {
					const url = new URL(value);
					if (url.protocol !== "http:" && url.protocol !== "https:") {
						throw new Error("Base URL must be http(s)");
					}
					form.baseUrl = value.replace(/\/+$/u, "");
					form.id = uniqueEndpointId(new Set(this.endpoints.map((endpoint) => endpoint.id)), form.baseUrl);
					form.name = url.hostname;
					break;
				}
				case 1: {
					if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
						throw new Error("Endpoint id must match [A-Za-z0-9][A-Za-z0-9._-]*");
					}
					if (this.endpoints.some((endpoint) => endpoint.id === value)) {
						throw new Error(`Endpoint "${value}" already exists`);
					}
					form.id = value;
					break;
				}
				case 2:
					if (!value.trim()) throw new Error("Name is required");
					form.name = value.trim();
					break;
				case 3:
					form.apiKey = value;
					break;
				case 5:
					form.headers = value;
					break;
			}
		} catch (error) {
			this.page = { ...page, error: error instanceof Error ? error.message : String(error) };
			this.renderDialog();
			return;
		}
		const nextStep = page.step + 1;
		if (nextStep === 4) form.api = "openai-completions";
		this.page = { ...page, form, step: nextStep, error: undefined };
		this.renderDialog();
	}

	private async advanceEditStep(value: string): Promise<void> {
		const page = this.page;
		if (page.kind !== "edit") return;
		const entry = { ...page.entry };
		try {
			switch (page.step) {
				case 0: {
					const url = new URL(value);
					if (url.protocol !== "http:" && url.protocol !== "https:") {
						throw new Error("Base URL must be http(s)");
					}
					entry.baseUrl = value.replace(/\/+$/u, "");
					break;
				}
				case 1:
					if (!value.trim()) throw new Error("Name is required");
					entry.name = value.trim();
					break;
				case 2:
					if (value) entry.apiKey = value;
					else delete entry.apiKey;
					break;
				case 3:
					entry.headers = parseHeadersText(value);
					break;
			}
		} catch (error) {
			this.page = { ...page };
			this.showStatusError(error instanceof Error ? error.message : String(error));
			return;
		}
		const nextStep = page.step + 1;
		if (nextStep === 4) {
			// api stays from the next select step.
		}
		this.page = { ...page, entry, step: nextStep };
		this.renderDialog();
	}

	private async advanceModelFormStep(value: string): Promise<void> {
		const page = this.page;
		if (page.kind !== "model-form") return;
		const form = { ...page.form };
		try {
			switch (page.step) {
				case 0:
					if (!value.trim()) throw new Error("Model id is required");
					form.id = value.trim();
					break;
				case 1:
					form.name = value;
					break;
				case 4:
					break; // Input is chosen via the select step, not typed.
				case 5: {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Context window must be a positive number");
					form.contextWindow = value;
					break;
				}
				case 6: {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Max tokens must be a positive number");
					form.maxTokens = value;
					break;
				}
			}
		} catch (error) {
			this.showStatusError(error instanceof Error ? error.message : String(error));
			return;
		}
		const nextStep = page.step + 1;
		if (nextStep === 7) {
			await this.saveModelForm(form);
			return;
		}
		this.page = { ...page, form, step: nextStep };
		this.renderDialog();
	}

	private async saveModelForm(form: ModelForm): Promise<void> {
		const page = this.page;
		if (page.kind !== "model-form") return;
		const entry = this.endpoints.find((endpoint) => endpoint.id === page.id)?.entry;
		if (!entry) return;
		const models = [...(entry.models ?? [])];
		const definition: ModelsJsonModel = {
			id: form.id,
			...(form.name ? { name: form.name } : {}),
			enabled: form.enabled,
			reasoning: form.reasoning,
			contextWindow: Number(form.contextWindow),
			maxTokens: Number(form.maxTokens),
			input: inputFromForm(form),
		};
		if (page.index >= 0) models[page.index] = definition;
		else models.push(definition);
		try {
			await updateEndpointModels(this.modelsPath, page.id, models);
			await this.refreshAndNotify();
			// syncSelection() owns page-entry selection (resets to the first row on page change)
			this.page = { kind: "models", id: page.id };
			this.renderDialog();
		} catch (error) {
			this.showStatusError(error instanceof Error ? error.message : String(error));
		}
	}

	private async saveCompat(value: string): Promise<void> {
		const page = this.page;
		if (page.kind !== "compat") return;
		let compat: unknown;
		try {
			compat = JSON.parse(value);
		} catch (error) {
			this.page = { ...page, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
			this.renderDialog();
			return;
		}
		try {
			await updateEndpointEntry(this.modelsPath, page.id, {
				compat: (compat && typeof compat === "object" ? compat : undefined) as ModelsJsonProvider["compat"],
			});
			await this.refreshAndNotify();
			this.page = { kind: "manage", id: page.id, entry: this.currentEntry(page.id)! };
			this.renderDialog();
		} catch (error) {
			this.showStatusError(error instanceof Error ? error.message : String(error));
		}
	}

	private currentEntry(id: string): ModelsJsonProvider | undefined {
		return this.endpoints.find((endpoint) => endpoint.id === id)?.entry;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const page = this.page;

		if (page.kind === "add" && (page.busy || page.discovered)) {
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.discoveryController?.abort();
				this.discoveryController = undefined;
				this.page = { ...page, busy: undefined, discovered: undefined };
				this.renderDialog();
			}
			return;
		}

		const usesInput =
			(page.kind === "add" && page.step < 4) ||
			(page.kind === "add" && page.step === 5) ||
			(page.kind === "edit" && page.step < 4) ||
			(page.kind === "model-form" && (page.step === 0 || page.step === 1 || page.step === 5 || page.step === 6)) ||
			(page.kind === "model-field" && !isChoiceModelField(page.field)) ||
			page.kind === "compat";
		if (usesInput) {
			this.input.handleInput(keyData);
			return;
		}

		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.renderDialog();
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.listLength() - 1, this.selectedIndex + 1);
			this.renderDialog();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			void this.confirm();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.stepBack();
		} else if (page.kind === "models" && kb.matches(keyData, "app.connect.toggleModel")) {
			void this.toggleSelectedModel();
		}
	}

	/** Page identity — selection resets when it changes. */
	private pageKey(page: Page): string {
		if (page.kind === "list") return "list";
		if (page.kind === "manage") return `manage:${page.id}`;
		if (page.kind === "add") {
			let state = "form";
			if (page.busy) state = "busy";
			else if (page.discovered) state = "found";
			return `add:${page.step}:${state}`;
		}
		if (page.kind === "edit") return `edit:${page.id}:${page.step}`;
		if (page.kind === "models") return `models:${page.id}`;
		if (page.kind === "model-form") return `model-form:${page.id}:${page.index}:${page.step}`;
		if (page.kind === "model-edit") return `model-edit:${page.id}:${page.index}`;
		if (page.kind === "model-field") return `model-field:${page.id}:${page.index}:${page.field}`;
		if (page.kind === "compat") return `compat:${page.id}`;
		return `confirm-delete:${page.id}`;
	}

	/** On page (re-)entry, point the arrow at the current value and clamp in range. */
	private syncSelection(): void {
		const page = this.page;
		const key = this.pageKey(page);
		if (key !== this.lastPageKey) {
			this.lastPageKey = key;
			if (page.kind === "add" && page.step === 4) {
				this.selectedIndex = Math.max(0, ENDPOINT_APIS.indexOf(page.form.api));
			} else if (page.kind === "add" && page.step === 6) {
				this.selectedIndex = page.form.discover ? 0 : 1;
			} else if (page.kind === "edit" && page.step === 4) {
				this.selectedIndex = Math.max(0, ENDPOINT_APIS.indexOf(entryApi(page.entry)));
			} else if (page.kind === "model-form" && page.step === 2) {
				this.selectedIndex = page.form.reasoning ? 0 : 1;
			} else if (page.kind === "model-form" && page.step === 3) {
				this.selectedIndex = page.form.enabled ? 0 : 1;
			} else if (page.kind === "model-form" && page.step === 4) {
				this.selectedIndex = page.form.input === "text+image" ? 1 : 0;
			} else if (page.kind === "model-field" && isChoiceModelField(page.field)) {
				const model = this.currentEntry(page.id)?.models?.[page.index];
				this.selectedIndex = modelChoiceIndex(model, page.field);
			} else {
				this.selectedIndex = 0;
			}
		}
		const max = this.listLength() - 1;
		if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
	}

	private listLength(): number {
		const page = this.page;
		if (page.kind === "list") return this.endpoints.length + 1;
		if (page.kind === "manage") return 5;
		if (page.kind === "add" && page.step === 4) return ENDPOINT_APIS.length;
		if (page.kind === "add" && page.step === 6) return 2;
		if (page.kind === "edit" && page.step === 4) return ENDPOINT_APIS.length;
		if (page.kind === "models") return (this.currentEntry(page.id)?.models?.length ?? 0) + 2;
		if (page.kind === "model-form" && (page.step === 2 || page.step === 3 || page.step === 4)) return 2;
		if (page.kind === "model-edit") return MODEL_EDIT_FIELDS.length + 1;
		if (page.kind === "model-field" && isChoiceModelField(page.field)) return 2;
		if (page.kind === "confirm-delete") return 2;
		return 0;
	}

	private async confirm(): Promise<void> {
		const page = this.page;
		if (page.kind === "list") {
			if (this.selectedIndex < this.endpoints.length) {
				const id = this.endpoints[this.selectedIndex]!.id;
				this.page = { kind: "manage", id, entry: this.currentEntry(id)! };
			} else {
				this.page = { kind: "add", step: 0, form: emptyForm() };
			}
			this.renderDialog();
		} else if (page.kind === "manage") {
			await this.confirmManage(page);
		} else if (page.kind === "add" && page.step === 4) {
			const form = { ...page.form, api: ENDPOINT_APIS[this.selectedIndex]! };
			this.page = { ...page, form, step: 5 };
			this.renderDialog();
		} else if (page.kind === "add" && page.step === 6) {
			const discover = this.selectedIndex === 0;
			const form = { ...page.form, discover };
			this.page = { ...page, form, step: 7 };
			await this.finishAdd();
		} else if (page.kind === "edit" && page.step === 4) {
			await this.saveEdit(ENDPOINT_APIS[this.selectedIndex]!);
		} else if (page.kind === "models") {
			await this.confirmModels(page);
		} else if (page.kind === "model-edit") {
			this.confirmModelEdit(page);
		} else if (page.kind === "model-field" && isChoiceModelField(page.field)) {
			const patch: Partial<ModelsJsonModel> = {};
			if (page.field === "input") patch.input = this.selectedIndex === 1 ? ["text", "image"] : ["text"];
			else if (page.field === "reasoning") patch.reasoning = this.selectedIndex === 0;
			else patch.enabled = this.selectedIndex === 0;
			await this.applyModelFieldPatch(page, patch);
		} else if (page.kind === "model-form" && (page.step === 2 || page.step === 3 || page.step === 4)) {
			const form = { ...page.form };
			if (page.step === 2) form.reasoning = this.selectedIndex === 0;
			else if (page.step === 3) form.enabled = this.selectedIndex === 0;
			else form.input = this.selectedIndex === 1 ? "text+image" : "text";
			this.page = { ...page, form, step: page.step + 1 };
			this.renderDialog();
		} else if (page.kind === "confirm-delete") {
			if (this.selectedIndex === 0) {
				try {
					await deleteEndpointEntry(this.modelsPath, page.id);
					await this.refreshAndNotify();
					this.page = { kind: "list" };
					this.renderDialog();
				} catch (error) {
					this.showStatusError(error instanceof Error ? error.message : String(error));
				}
			} else {
				this.page = { kind: "manage", id: page.id, entry: this.currentEntry(page.id)! };
				this.renderDialog();
			}
		}
	}

	private async confirmManage(page: Extract<Page, { kind: "manage" }>): Promise<void> {
		const id = page.id;
		const entry = this.currentEntry(id);
		if (!entry) return;
		switch (this.selectedIndex) {
			case 0:
				this.page = { kind: "edit", id, entry, step: 0 };
				this.renderDialog();
				break;
			case 1:
				this.page = { kind: "models", id };
				this.renderDialog();
				break;
			case 2:
				await this.rediscover(id, entry);
				break;
			case 3: {
				const compat = entry.compat ? JSON.stringify(entry.compat, null, 2) : "{}";
				this.page = { kind: "compat", id, step: 0, text: compat };
				this.renderDialog();
				break;
			}
			case 4:
				this.page = { kind: "confirm-delete", id };
				this.renderDialog();
				break;
		}
	}

	private async confirmModels(page: Extract<Page, { kind: "models" }>): Promise<void> {
		const entry = this.currentEntry(page.id);
		if (!entry) return;
		const models = entry.models ?? [];
		if (this.selectedIndex < models.length) {
			this.page = { kind: "model-edit", id: page.id, index: this.selectedIndex };
			this.selectedIndex = 0;
			this.renderDialog();
		} else if (this.selectedIndex === models.length) {
			const form: ModelForm = {
				id: "",
				name: "",
				reasoning: false,
				enabled: true,
				input: "text",
				contextWindow: "128000",
				maxTokens: "16384",
			};
			this.page = { kind: "model-form", id: page.id, index: -1, step: 0, form };
			this.renderDialog();
		} else {
			this.page = { kind: "manage", id: page.id, entry };
			this.renderDialog();
		}
	}

	/** Enter on a model row opens the per-field edit menu; the last row goes back. */
	private confirmModelEdit(page: Extract<Page, { kind: "model-edit" }>): void {
		if (this.selectedIndex < MODEL_EDIT_FIELDS.length) {
			this.page = {
				kind: "model-field",
				id: page.id,
				index: page.index,
				field: MODEL_EDIT_FIELDS[this.selectedIndex]!,
			};
			this.selectedIndex = 0;
			this.renderDialog();
			return;
		}
		this.page = { kind: "models", id: page.id };
		this.selectedIndex = page.index;
		this.lastPageKey = this.pageKey(this.page);
		this.renderDialog();
	}

	private async toggleSelectedModel(): Promise<void> {
		const page = this.page;
		if (page.kind !== "models") return;
		const entry = this.currentEntry(page.id);
		const models = entry?.models ?? [];
		if (this.selectedIndex >= models.length) return;
		const next = models.map((model, index) =>
			index === this.selectedIndex ? { ...model, enabled: model.enabled === false } : model,
		);
		try {
			await updateEndpointModels(this.modelsPath, page.id, next);
			await this.refreshAndNotify();
			this.renderDialog();
		} catch (error) {
			this.showStatusError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Validate a text field edit, write it, and return to the field menu. */
	private async submitModelField(value: string): Promise<void> {
		const page = this.page;
		if (page.kind !== "model-field") return;
		const models = this.currentEntry(page.id)?.models ?? [];
		const model = models[page.index];
		if (!model) return;
		let patch: Partial<ModelsJsonModel>;
		try {
			switch (page.field) {
				case "id": {
					const id = value.trim();
					if (!id) throw new Error("Model id is required");
					if (models.some((entry, index) => index !== page.index && entry.id === id)) {
						throw new Error(`Model "${id}" already exists on this endpoint`);
					}
					patch = { id };
					break;
				}
				case "name":
					patch = { name: value.trim() || undefined };
					break;
				case "contextWindow": {
					const parsed = Number(value);
					if (!Number.isInteger(parsed) || parsed <= 0) {
						throw new Error("Context window must be a positive integer");
					}
					patch = { contextWindow: parsed };
					break;
				}
				case "maxTokens": {
					const parsed = Number(value);
					if (!Number.isInteger(parsed) || parsed <= 0) {
						throw new Error("Max tokens must be a positive integer");
					}
					patch = { maxTokens: parsed };
					break;
				}
				default:
					return;
			}
		} catch (error) {
			this.showStatusError(error instanceof Error ? error.message : String(error));
			return;
		}
		await this.applyModelFieldPatch(page, patch);
	}

	private async applyModelFieldPatch(
		page: Extract<Page, { kind: "model-field" }>,
		patch: Partial<ModelsJsonModel>,
	): Promise<void> {
		const entry = this.currentEntry(page.id);
		const models = [...(entry?.models ?? [])];
		if (page.index < 0 || page.index >= models.length) return;
		const next = { ...models[page.index]! } as Record<string, unknown>;
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete next[key];
			else next[key] = value;
		}
		models[page.index] = next as ModelsJsonModel;
		try {
			await updateEndpointModels(this.modelsPath, page.id, models);
			await this.refreshAndNotify();
		} catch (error) {
			this.showStatusError(error instanceof Error ? error.message : String(error));
			return;
		}
		this.page = { kind: "model-edit", id: page.id, index: page.index };
		this.selectedIndex = MODEL_EDIT_FIELDS.indexOf(page.field);
		this.lastPageKey = this.pageKey(this.page);
		this.renderDialog();
	}

	private async saveEdit(api: EndpointApi): Promise<void> {
		const page = this.page;
		if (page.kind !== "edit") return;
		const entry = page.entry;
		try {
			await updateEndpointEntry(this.modelsPath, page.id, { api });
			await this.refreshAndNotify();
			this.page = { kind: "manage", id: page.id, entry: { ...entry, api } };
			this.renderDialog();
		} catch (error) {
			this.showStatusError(error instanceof Error ? error.message : String(error));
		}
	}

	private async rediscover(id: string, entry: ModelsJsonProvider): Promise<void> {
		const page: Page = { kind: "add", step: 99, form: emptyForm(), busy: "Discovering models via /models…" };
		this.page = page;
		this.renderDialog();
		const controller = new AbortController();
		this.discoveryController = controller;
		try {
			const discovered = await discoverEndpointModels({
				api: entryApi(entry),
				baseUrl: entry.baseUrl ?? "",
				apiKey: entry.apiKey,
				headers: entry.headers,
				signal: controller.signal,
			});
			const existing = entry.models ?? [];
			const merged = mergeDiscoveredModels(existing, modelDefinitionsFromDiscovery(discovered, entryApi(entry)));
			await updateEndpointModels(this.modelsPath, id, merged);
			await this.refreshAndNotify();
			const updated = this.currentEntry(id);
			this.page = { kind: "manage", id, entry: updated ?? entry };
			this.renderDialog();
		} catch (error) {
			if (controller.signal.aborted) {
				this.page = { kind: "manage", id, entry };
			} else {
				this.showStatusError(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
				this.page = { kind: "manage", id, entry };
			}
			this.renderDialog();
		} finally {
			this.discoveryController = undefined;
		}
	}

	private async finishAdd(): Promise<void> {
		const page = this.page;
		if (page.kind !== "add") return;
		const form = page.form;
		if (!form.discover) {
			await this.writeAdd(form, undefined);
			return;
		}
		this.page = { ...page, busy: "Discovering models via /models…" };
		this.renderDialog();
		const controller = new AbortController();
		this.discoveryController = controller;
		try {
			const discovered = await discoverEndpointModels({
				api: form.api,
				baseUrl: form.baseUrl,
				apiKey: form.apiKey || undefined,
				headers: parseHeadersText(form.headers),
				signal: controller.signal,
			});
			this.page = { ...page, busy: undefined, discovered };
			this.renderDialog();
			await this.writeAdd(form, modelDefinitionsFromDiscovery(discovered, form.api));
		} catch (error) {
			if (controller.signal.aborted) {
				this.page = { ...page, busy: undefined };
			} else {
				this.page = {
					...page,
					busy: undefined,
					error: `Model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			this.renderDialog();
		} finally {
			this.discoveryController = undefined;
		}
	}

	private async writeAdd(form: AddForm, models: ModelsJsonModel[] | undefined): Promise<void> {
		try {
			await writeEndpointEntry(
				this.modelsPath,
				{
					id: form.id,
					name: form.name,
					baseUrl: form.baseUrl,
					api: form.api,
					apiKey: form.apiKey || undefined,
					headers: parseHeadersText(form.headers),
				},
				models,
			);
			await this.refreshAndNotify();
			this.page = { kind: "list" };
			this.renderDialog();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.page = { kind: "add", step: 99, form, error: message };
			this.renderDialog();
		}
	}

	private async refreshAndNotify(): Promise<void> {
		await this.options.modelRuntime.refresh({ allowNetwork: false });
		await this.loadEndpoints();
		await this.options.onChanged();
	}

	private stepBack(): void {
		const page = this.page;
		if (page.kind === "list") {
			this.options.onClose();
			return;
		}
		if (page.kind === "add") {
			if (page.step === 0) {
				this.page = { kind: "list" };
			} else {
				const step = page.step - 1;
				const form = { ...page.form };
				if (step === 3 && form.apiKey === undefined) form.apiKey = "";
				this.page = { ...page, step, error: undefined };
			}
			this.renderDialog();
			return;
		}
		if (page.kind === "edit") {
			if (page.step === 0) {
				this.page = { kind: "manage", id: page.id, entry: page.entry };
			} else {
				this.page = { ...page, step: page.step - 1 };
			}
			this.renderDialog();
			return;
		}
		if (page.kind === "manage") {
			this.page = { kind: "list" };
			this.renderDialog();
			return;
		}
		if (page.kind === "models") {
			this.page = { kind: "manage", id: page.id, entry: this.currentEntry(page.id)! };
			this.renderDialog();
			return;
		}
		if (page.kind === "model-form") {
			if (page.step === 0) {
				this.selectedIndex = 0;
				this.page = { kind: "models", id: page.id };
			} else {
				this.page = { ...page, step: page.step - 1 };
			}
			this.renderDialog();
			return;
		}
		if (page.kind === "model-edit") {
			this.page = { kind: "models", id: page.id };
			this.selectedIndex = page.index;
			this.lastPageKey = this.pageKey(this.page);
			this.renderDialog();
			return;
		}
		if (page.kind === "model-field") {
			this.page = { kind: "model-edit", id: page.id, index: page.index };
			this.selectedIndex = MODEL_EDIT_FIELDS.indexOf(page.field);
			this.lastPageKey = this.pageKey(this.page);
			this.renderDialog();
			return;
		}
		if (page.kind === "compat") {
			this.page = { kind: "manage", id: page.id, entry: this.currentEntry(page.id)! };
			this.renderDialog();
			return;
		}
		if (page.kind === "confirm-delete") {
			this.page = { kind: "manage", id: page.id, entry: this.currentEntry(page.id)! };
			this.renderDialog();
		}
	}

	private showStatusError(message: string): void {
		this.options.onError(message);
		this.renderDialog();
	}
}

function emptyForm(): AddForm {
	return {
		id: "",
		baseUrl: "",
		name: "",
		apiKey: "",
		api: "openai-completions",
		headers: "",
		discover: true,
	};
}

function formatHeaders(headers: Record<string, string> | undefined): string {
	if (!headers) return "";
	return Object.entries(headers)
		.map(([name, value]) => `${name}: ${value}`)
		.join(", ");
}

function modelsJsonPath(): string {
	return join(getAgentDir(), "models.json");
}
