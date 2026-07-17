import test from 'node:test';
import assert from 'node:assert/strict';
import { getTask, submit, submitAndWait } from '../../nodes/asyncTask/operations';

// Intégration contre une async-api réelle (stack locale, broker actif, sans worker
// consommateur → les tâches restent en `pending`, ce qui suffit à valider submit/get/polling).
const BASE_URL = process.env.ASYNC_API_URL ?? 'http://127.0.0.1:8099';

function realExecFns(clientId: string, clientSecret: string, params: Record<string, unknown>) {
	const auth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
	return {
		getNode: () => ({
			name: 'AsyncTask',
			type: 'asyncTask',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		async getCredentials() {
			return { baseUrl: BASE_URL, clientId, clientSecret };
		},
		helpers: {
			async httpRequestWithAuthentication(
				_cred: string,
				opts: { method: string; baseURL: string; url: string; body?: unknown },
			) {
				const res = await fetch(`${opts.baseURL}${opts.url}`, {
					method: opts.method,
					headers: { Authorization: auth, 'Content-Type': 'application/json' },
					body: opts.body ? JSON.stringify(opts.body) : undefined,
				});
				const text = await res.text();
				const json = text ? JSON.parse(text) : {};
				if (!res.ok) {
					const err = new Error(`HTTP ${res.status}`) as Error & {
						httpCode: string;
						response: { body: unknown };
					};
					err.httpCode = String(res.status);
					err.response = { body: json };
					throw err;
				}
				return json;
			},
		},
	} as any;
}

test('live: submit crée une tâche et renvoie task_id + statut pending', async () => {
	const fns = realExecFns('n8n_client', 'n8n_secret', {
		service: 'extract-text',
		body: { file_id: 'n8n_client/test/dummy.pdf' },
	});

	const data = await submit(fns, 0);

	assert.ok(data.task_id, 'task_id présent');
	assert.equal(data.status, 'pending');
});

test('live: get renvoie le statut de la tâche soumise', async () => {
	const submitFns = realExecFns('n8n_client', 'n8n_secret', {
		service: 'extract-text',
		body: { file_id: 'n8n_client/test/dummy.pdf' },
	});
	const created = await submit(submitFns, 0);

	const getFns = realExecFns('n8n_client', 'n8n_secret', {
		service: 'extract-text',
		taskId: created.task_id,
	});
	const data = await getTask(getFns, 0);

	assert.equal(data.task_id, created.task_id);
	assert.ok(['pending', 'in_progress', 'success', 'failure'].includes(data.status));
});

test('live: submitAndWait dépasse le délai (pas de worker) → erreur « toujours en cours »', async () => {
	const fns = realExecFns('n8n_client', 'n8n_secret', {
		service: 'extract-text',
		body: { file_id: 'n8n_client/test/dummy.pdf' },
		waitOptions: { pollIntervalSeconds: 0.5, timeoutSeconds: 1 },
	});

	await assert.rejects(submitAndWait(fns, 0), /toujours en cours|délai dépassé/);
});

test('live: body invalide → message d\'erreur lisible sur le champ', async () => {
	const fns = realExecFns('n8n_client', 'n8n_secret', {
		service: 'extract-text',
		body: { wrong_field: 123 },
	});

	await assert.rejects(submit(fns, 0), /schéma|champ|Code API/i);
});
