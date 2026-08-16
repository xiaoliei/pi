import { join } from "node:path";
import { getDocsPath } from "../config.ts";

export function getProviderLoginHelp(): string {
	return [
		"Use /connect to add an API endpoint (baseUrl + key + protocol). See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	return `No API key found for ${provider}.\n\n${getProviderLoginHelp()}`;
}
