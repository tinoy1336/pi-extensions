/**
 * vision-models.ts — the model ids that read images.
 *
 * The list is the built-in set plus whatever the operator setting adds, and the predicate
 * accepts an id bare, an id with a variant suffix, or `provider/id`, because a provider
 * may report any of those for the same model. Both extensions that register or hide an
 * image tool need this answer about the SAME session's model, so one copy is what keeps
 * them from disagreeing about it.
 */

/** The ids this release ships with: the ones verified to read images. */
export const DEFAULT_VISION_MODEL_IDS: readonly string[] = ["glm-5.3-flash", "deepseek-flash"];

/** Operator setting: comma- or space-separated model ids appended to the defaults, each
 *  either a bare model id (`my-model`) or `provider/model-id`. */
export const VISION_MODELS_SETTING = "PI_VISION_MODELS";

/** Every id considered vision-capable: the defaults plus the setting's additions. */
export function visionModelIds(): string[] {
	const configured = process.env[VISION_MODELS_SETTING] ?? "";
	const extra = configured.split(/[,\s]+/).filter(Boolean);
	return [...new Set([...DEFAULT_VISION_MODEL_IDS, ...extra])];
}

/** Whether this session's model can read images. */
export function isVisionModel(model: { provider: string; id: string } | undefined): boolean {
	if (!model) return false;
	return visionModelIds().some(
		(id) =>
			model.id === id || model.id.startsWith(`${id}-`) || `${model.provider}/${model.id}` === id,
	);
}
