import test from 'node:test';
import assert from 'node:assert/strict';
import { getServices } from '../../nodes/asyncTask/services';

// Intégration contre une instance async-api réelle (stack locale).
// Prérequis : API joignable + clients de test créés (voir README / procédure de validation).
const BASE_URL = process.env.ASYNC_API_URL ?? 'http://127.0.0.1:8099';

/**
 * Construit un faux `ILoadOptionsFunctions` dont le helper effectue de VRAIES
 * requêtes HTTP Basic — on teste ainsi le vrai `getServices` de bout en bout.
 */
function realLoadOptionsFns(clientId: string, clientSecret: string) {
	const authHeader = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
	return {
		async getCredentials() {
			return { baseUrl: BASE_URL, clientId, clientSecret };
		},
		helpers: {
			async httpRequestWithAuthentication(
				_cred: string,
				opts: { method: string; baseURL: string; url: string },
			) {
				const res = await fetch(`${opts.baseURL}${opts.url}`, {
					method: opts.method,
					headers: { Authorization: authHeader },
				});
				if (!res.ok) throw new Error(`HTTP ${res.status} on ${opts.url}`);
				return res.json();
			},
		},
	} as any;
}

test('live: client autorisé sur 2 services → dropdown = intersection triée', async () => {
	const result = await getServices.call(realLoadOptionsFns('n8n_client', 'n8n_secret'));

	assert.deepEqual(
		result.map((o) => o.value),
		['classify-document', 'extract-text'],
	);
});

test('live: client "all" → dropdown = tous les services de l\'API', async () => {
	const result = await getServices.call(realLoadOptionsFns('all_client', 'all_secret'));

	// au moins les services de base du catalogue local
	const names = result.map((o) => o.value);
	assert.ok(names.includes('extract-text'));
	assert.ok(names.includes('classify-document'));
	assert.ok(names.length >= 3);
});

test('live: client autorisé sur un service inexistant → dropdown vide', async () => {
	const result = await getServices.call(realLoadOptionsFns('svc_client', 'svc_secret'));

	assert.deepEqual(result, []);
});
