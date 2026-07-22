import {
	IExecuteFunctions,
	IDataObject,
	IHttpRequestMethods,
	INodeExecutionData,
	JsonObject,
	NodeApiError,
	NodeOperationError,
	sleep,
} from 'n8n-workflow';
import { Blob } from 'node:buffer';

const CREDENTIALS_NAME = 'asyncTaskApi';

/** Statuts renvoyés par l'API (api/schemas/enum.py). */
const TERMINAL_STATUSES = ['success', 'failure'] as const;
const STATUS_SUCCESS = 'success';
const STATUS_FAILURE = 'failure';

/** Bornes de polling par défaut pour « Soumettre et attendre ». */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Codes HTTP transitoires pendant le polling : un aléa côté infra (gateway,
 * dépendance LLM qui renvoie 5xx le temps d'un retry worker…) ne doit PAS faire
 * échouer une tâche qui, elle, finit en succès. On retente le poll au lieu de jeter.
 */
const TRANSIENT_POLL_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/** Échecs de poll CONSÉCUTIFS tolérés avant d'abandonner (un succès remet à zéro). */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

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

/** Extrait le code HTTP d'une erreur (axios/n8n), quelle que soit sa forme. */
function httpStatusFromError(error: unknown): number | undefined {
	const e = error as {
		httpCode?: string | number;
		statusCode?: number;
		status?: number;
		response?: { status?: number; statusCode?: number };
		cause?: { response?: { status?: number; statusCode?: number }; statusCode?: number };
	};
	const raw =
		e.response?.status ??
		e.response?.statusCode ??
		e.statusCode ??
		e.status ??
		e.cause?.response?.status ??
		e.cause?.response?.statusCode ??
		e.cause?.statusCode;
	if (typeof raw === 'number') {
		return raw;
	}
	const parsed = Number(e.httpCode);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Une erreur de poll est-elle transitoire (à retenter) plutôt que définitive ?
 * - 5xx / 408 / 429 → transitoire.
 * - pas de code exploitable (timeout/réseau) → transitoire.
 * - 4xx (401/403/404…) → définitive, on remonte l'erreur.
 */
function isTransientPollError(error: unknown): boolean {
	const status = httpStatusFromError(error);
	if (status === undefined) {
		return true;
	}
	return TRANSIENT_POLL_HTTP_STATUSES.has(status);
}

/**
 * Un poll : GET du statut de la tâche. Laisse remonter l'erreur BRUTE (sans la
 * remapper) pour que l'appelant puisse décider transitoire vs définitive.
 */
async function requestTaskStatus(
	ctx: IExecuteFunctions,
	service: string,
	taskId: string,
): Promise<TaskData> {
	const credentials = await ctx.getCredentials(CREDENTIALS_NAME);
	const baseURL = normalizeBaseUrl(credentials.baseUrl as string);
	const response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIALS_NAME, {
		method: 'GET',
		baseURL,
		url: `/v1/services/${encodeURIComponent(service)}/tasks/${encodeURIComponent(taskId)}`,
		json: true,
	})) as unknown as TaskResponse;
	return response.data;
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
	let consecutivePollFailures = 0;
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
		try {
			current = await requestTaskStatus(ctx, service, taskId);
			consecutivePollFailures = 0;
		} catch (error) {
			// Erreur définitive (4xx) : la tâche/route est vraiment en faute → on remonte.
			if (!isTransientPollError(error)) {
				throw toReadableError(ctx, error, itemIndex);
			}
			// Erreur transitoire (5xx/réseau) : on retente au prochain tour tant que ça
			// ne se répète pas trop. Un poll réussi remet le compteur à zéro, donc des
			// 500 intermittents n'échouent jamais une tâche qui finit en succès.
			consecutivePollFailures += 1;
			if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
				throw new NodeOperationError(
					ctx.getNode(),
					`Statut de la tâche ${taskId} indisponible après ${MAX_CONSECUTIVE_POLL_FAILURES} tentatives consécutives (erreurs transitoires répétées).`,
					{
						itemIndex,
						description: `Dernier code HTTP : ${httpStatusFromError(error) ?? 'réseau/timeout'}.`,
					},
				);
			}
		}
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

// --------------------------------------------------------------------------
// Fichiers (#480) — /storage/upload, presigned upload (gros scans), download
// --------------------------------------------------------------------------

const DEFAULT_BINARY_PROPERTY = 'data';
const DEFAULT_MIME_TYPE = 'application/octet-stream';

interface PresignedUploadResponse {
	url: string;
	fields: IDataObject;
	file_id: string;
}

interface PresignedDownloadResponse {
	url: string;
	expires_in_seconds?: number;
}

/** Lit le binaire d'entrée du nœud (nom de propriété, buffer, filename, mime). */
async function readInputBinary(
	ctx: IExecuteFunctions,
	itemIndex: number,
): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
	const binaryProperty = ctx.getNodeParameter(
		'binaryPropertyName',
		itemIndex,
		DEFAULT_BINARY_PROPERTY,
	) as string;
	const binary = ctx.helpers.assertBinaryData(itemIndex, binaryProperty);
	const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, binaryProperty);
	return {
		buffer,
		filename: binary.fileName || 'upload',
		mimeType: binary.mimeType || DEFAULT_MIME_TYPE,
	};
}

/**
 * Seuil (octets) au-delà duquel on bascule sur la presigned URL. Aligné sur la limite
 * `nginx.ingress…/proxy-body-size: 25m` : au-delà, un upload transitant par l'API/ingress
 * est rejeté → il faut l'upload direct S3 via presigned.
 */
const DIRECT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Upload direct (petits fichiers) : `POST /storage/upload` (multipart) → `{file_id}`. */
async function directUpload(
	ctx: IExecuteFunctions,
	buffer: Buffer,
	filename: string,
	mimeType: string,
): Promise<IDataObject> {
	const credentials = await ctx.getCredentials(CREDENTIALS_NAME);
	const baseURL = normalizeBaseUrl(credentials.baseUrl as string);

	const formData = new FormData();
	formData.append('file', new Blob([buffer], { type: mimeType }), filename);

	const res = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIALS_NAME, {
		method: 'POST',
		baseURL,
		url: '/storage/upload',
		body: formData,
	})) as IDataObject;
	return { ...res, upload_mode: 'direct' };
}

/** Détecte une erreur d'upload liée à la taille (→ repli automatique sur presigned). */
function isSizeLimitError(error: unknown): boolean {
	const err = error as {
		httpCode?: string | number;
		response?: { data?: unknown; body?: unknown };
		message?: string;
	};
	if (String(err.httpCode ?? '') === '413') {
		return true;
	}
	const haystack = `${JSON.stringify(err.response?.data ?? err.response?.body ?? '')}${err.message ?? ''}`;
	return /exceeded maximum size|entity too large|TEXT_TOO_LARGE|too large/i.test(haystack);
}

/**
 * Gros fichiers : `POST /storage/presigned-upload` (url + fields) puis upload **direct
 * vers S3** (multipart), renvoie `{file_id}`.
 */
async function presignedUploadFlow(
	ctx: IExecuteFunctions,
	itemIndex: number,
	buffer: Buffer,
	filename: string,
	mimeType: string,
): Promise<IDataObject> {
	const presign = (await apiRequest(ctx, itemIndex, 'POST', '/storage/presigned-upload', {
		filename,
		mime_type: mimeType,
	})) as unknown as PresignedUploadResponse;

	const formData = new FormData();
	// Les `fields` de la policy S3 doivent précéder le champ `file`.
	for (const [key, value] of Object.entries(presign.fields ?? {})) {
		formData.append(key, String(value));
	}
	formData.append('file', new Blob([buffer], { type: mimeType }), filename);

	try {
		// POST direct vers S3 : pas d'auth Basic (l'autorisation est dans `fields`).
		await ctx.helpers.httpRequest({ method: 'POST', url: presign.url, body: formData });
	} catch (error) {
		throw new NodeOperationError(
			ctx.getNode(),
			"Échec de l'upload direct vers le stockage (presigned expirée ou fichier trop gros ?).",
			{ itemIndex, description: (error as Error)?.message },
		);
	}
	return { file_id: presign.file_id, upload_mode: 'presigned' };
}

/**
 * Envoie un fichier en **choisissant automatiquement le mode selon la taille** :
 * ≤ 25 MB → upload direct via l'API (`/storage/upload`) ; > 25 MB → presigned URL
 * (upload direct S3, contourne la limite `proxy-body-size` de l'ingress).
 * Renvoie `{file_id, upload_mode}`.
 */
export async function uploadFile(ctx: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const { buffer, filename, mimeType } = await readInputBinary(ctx, itemIndex);
	if (buffer.length > DIRECT_UPLOAD_MAX_BYTES) {
		return presignedUploadFlow(ctx, itemIndex, buffer, filename, mimeType);
	}
	try {
		return await directUpload(ctx, buffer, filename, mimeType);
	} catch (error) {
		// Repli auto : si l'API rejette pour cause de taille (limite plus basse que le seuil),
		// on bascule sur l'upload direct S3 via presigned au lieu d'un message cryptique.
		if (isSizeLimitError(error)) {
			return presignedUploadFlow(ctx, itemIndex, buffer, filename, mimeType);
		}
		throw toReadableError(ctx, error, itemIndex);
	}
}

/**
 * Récupère un fichier résultat : `POST /storage/presigned-download` puis GET de la
 * presigned URL → renvoie le contenu en **binaire** n8n.
 */
export async function presignedDownload(
	ctx: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const fileId = ctx.getNodeParameter('fileId', itemIndex) as string;
	const binaryProperty = ctx.getNodeParameter(
		'binaryPropertyName',
		itemIndex,
		DEFAULT_BINARY_PROPERTY,
	) as string;

	const presign = (await apiRequest(ctx, itemIndex, 'POST', '/storage/presigned-download', {
		file_id: fileId,
	})) as unknown as PresignedDownloadResponse;

	const response = (await ctx.helpers.httpRequest({
		method: 'GET',
		url: presign.url,
		encoding: 'arraybuffer',
		returnFullResponse: true,
	})) as { body: Buffer };

	const buffer = Buffer.from(response.body);
	const fileName = fileId.split('/').pop() || 'download';
	const binaryData = await ctx.helpers.prepareBinaryData(buffer, fileName);

	return { json: { file_id: fileId }, binary: { [binaryProperty]: binaryData } };
}
