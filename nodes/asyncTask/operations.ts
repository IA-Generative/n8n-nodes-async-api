import {
	IExecuteFunctions,
	IDataObject,
	IHttpRequestMethods,
	JsonObject,
	NodeApiError,
	NodeOperationError,
	sleep,
} from 'n8n-workflow';

const CREDENTIALS_NAME = 'asyncTaskApi';

/** Statuts renvoyés par l'API (api/schemas/enum.py). */
const TERMINAL_STATUSES = ['success', 'failure'] as const;
const STATUS_SUCCESS = 'success';
const STATUS_FAILURE = 'failure';

/** Bornes de polling par défaut pour « Soumettre et attendre ». */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MILLISECONDS_PER_SECOND = 1000;

interface TaskData {
	task_id: string;
	status: string;
	progress?: number | null;
	result?: unknown;
	error_message?: string | null;
	submission_date?: string | null;
	start_date?: string | null;
	end_date?: string | null;
	task_position?: number | null;
}

interface TaskResponse {
	status: string;
	data: TaskData;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '');
}

/**
 * Appelle l'API async avec l'auth Basic de la credential, et remappe les erreurs
 * du format unifié `{error:{code,message}}` en message lisible (NodeApiError).
 */
async function apiRequest(
	ctx: IExecuteFunctions,
	itemIndex: number,
	method: IHttpRequestMethods,
	url: string,
	body?: IDataObject,
): Promise<IDataObject> {
	const credentials = await ctx.getCredentials(CREDENTIALS_NAME);
	const baseURL = normalizeBaseUrl(credentials.baseUrl as string);
	try {
		return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIALS_NAME, {
			method,
			baseURL,
			url,
			body,
			json: true,
		})) as IDataObject;
	} catch (error) {
		throw toReadableError(ctx, error, itemIndex);
	}
}

/** Transforme une erreur HTTP de l'API en message lisible pour l'utilisateur n8n. */
function toReadableError(ctx: IExecuteFunctions, error: unknown, itemIndex: number): Error {
	// n8n (client axios) expose le corps de réponse selon les versions à des endroits
	// différents : on lit toutes les localisations connues pour retrouver `{error:{code}}`.
	const err = error as {
		response?: { data?: unknown; body?: unknown };
		cause?: { response?: { data?: unknown; body?: unknown } };
	};
	const rawBody =
		err.response?.data ??
		err.response?.body ??
		err.cause?.response?.data ??
		err.cause?.response?.body ??
		{};
	const body = rawBody as { error?: { code?: string; message?: string } };
	const code = body.error?.code;
	const apiMessage = body.error?.message;

	const friendlyByCode: Record<string, string> = {
		AUTHENTICATION_REQUIRED: 'Authentification échouée : vérifiez vos identifiants.',
		SERVICE_FORBIDDEN: "Vous n'êtes pas autorisé pour ce service.",
		SERVICE_NOT_FOUND: "Ce service n'existe pas.",
		TASK_NOT_FOUND: 'Tâche introuvable.',
		FILE_NOT_FOUND: 'Fichier introuvable.',
		BODY_SCHEMA_INVALID: "Le corps de la requête ne respecte pas le schéma du service.",
		TEXT_TOO_LARGE: 'Le contenu est trop volumineux.',
		SERVICE_QUOTA_EXCEEDED: 'Quota du service atteint, réessayez plus tard.',
		CLIENT_SERVICE_QUOTA_EXCEEDED: 'Quota atteint pour ce service, réessayez plus tard.',
	};

	const message = (code && friendlyByCode[code]) || apiMessage || 'Erreur API async-api.';
	return new NodeApiError(ctx.getNode(), (body as unknown as JsonObject) ?? {}, {
		message,
		description: code ? `Code API : ${code}` : undefined,
		itemIndex,
	});
}

/**
 * Normalise le paramètre `body` (type n8n `json`) : n8n peut renvoyer soit un
 * objet, soit une chaîne JSON. On garantit un objet, avec message clair si le
 * JSON est mal formé.
 */
function parseBodyParam(ctx: IExecuteFunctions, itemIndex: number): IDataObject {
	const raw = ctx.getNodeParameter('body', itemIndex, {});
	if (typeof raw !== 'string') {
		return raw as IDataObject;
	}
	if (raw.trim() === '') {
		return {};
	}
	try {
		return JSON.parse(raw) as IDataObject;
	} catch {
		throw new NodeOperationError(ctx.getNode(), 'Body (JSON) invalide : le JSON est mal formé.', {
			itemIndex,
		});
	}
}

/** Soumet une tâche et renvoie les données de création (task_id, status pending…). */
export async function submit(ctx: IExecuteFunctions, itemIndex: number): Promise<TaskData> {
	const service = ctx.getNodeParameter('service', itemIndex) as string;
	const body = parseBodyParam(ctx, itemIndex);

	const response = (await apiRequest(
		ctx,
		itemIndex,
		'POST',
		`/v1/services/${encodeURIComponent(service)}/tasks`,
		{ body },
	)) as unknown as TaskResponse;

	return response.data;
}

/** Interroge l'état/résultat d'une tâche (un seul appel). */
export async function getTask(ctx: IExecuteFunctions, itemIndex: number): Promise<TaskData> {
	const service = ctx.getNodeParameter('service', itemIndex) as string;
	const taskId = ctx.getNodeParameter('taskId', itemIndex) as string;

	const response = (await apiRequest(
		ctx,
		itemIndex,
		'GET',
		`/v1/services/${encodeURIComponent(service)}/tasks/${encodeURIComponent(taskId)}`,
	)) as unknown as TaskResponse;

	return response.data;
}

function isTerminal(status: string): boolean {
	return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Soumet une tâche puis attend jusqu'à un statut terminal (success/failure),
 * en bornant par un timeout. Renvoie le résultat en cas de succès ; lève une
 * erreur explicite (motif) en cas d'échec ou de timeout.
 */
export async function submitAndWait(ctx: IExecuteFunctions, itemIndex: number): Promise<TaskData> {
	const service = ctx.getNodeParameter('service', itemIndex) as string;
	const waitOptions = ctx.getNodeParameter('waitOptions', itemIndex, {}) as {
		pollIntervalSeconds?: number;
		timeoutSeconds?: number;
	};
	// Garde-fou : une valeur <= 0 (via expression) retomberait sinon sur un timeout
	// immédiat / une boucle serrée. On revient au défaut si la valeur n'est pas > 0.
	const pollSeconds =
		Number(waitOptions.pollIntervalSeconds) > 0
			? Number(waitOptions.pollIntervalSeconds)
			: DEFAULT_POLL_INTERVAL_SECONDS;
	const timeoutSeconds =
		Number(waitOptions.timeoutSeconds) > 0
			? Number(waitOptions.timeoutSeconds)
			: DEFAULT_TIMEOUT_SECONDS;
	const pollIntervalMs = pollSeconds * MILLISECONDS_PER_SECOND;
	const timeoutMs = timeoutSeconds * MILLISECONDS_PER_SECOND;

	const created = await submit(ctx, itemIndex);
	const taskId = created.task_id;

	let elapsed = 0;
	let current = created;
	while (!isTerminal(current.status)) {
		if (elapsed >= timeoutMs) {
			throw new NodeOperationError(
				ctx.getNode(),
				`La tâche ${taskId} est toujours en cours après ${timeoutMs / MILLISECONDS_PER_SECOND}s (délai dépassé).`,
				{ itemIndex, description: `Dernier statut : ${current.status}.` },
			);
		}
		await sleep(pollIntervalMs);
		elapsed += pollIntervalMs;
		const response = (await apiRequest(
			ctx,
			itemIndex,
			'GET',
			`/v1/services/${encodeURIComponent(service)}/tasks/${encodeURIComponent(taskId)}`,
		)) as unknown as TaskResponse;
		current = response.data;
	}

	if (current.status === STATUS_FAILURE) {
		throw new NodeOperationError(
			ctx.getNode(),
			`La tâche a échoué : ${current.error_message ?? 'motif inconnu'}`,
			{ itemIndex },
		);
	}
	if (current.status === STATUS_SUCCESS) {
		return current;
	}
	// défensif : statut terminal inattendu
	throw new NodeOperationError(ctx.getNode(), `Statut de tâche inattendu : ${current.status}`, {
		itemIndex,
	});
}
