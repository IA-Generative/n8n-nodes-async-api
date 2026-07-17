import test from 'node:test';
import assert from 'node:assert/strict';
import { getServices } from '../../nodes/asyncTask/services';

interface FakeOpts {
	services: Array<{ name: string }>;
	me: { authorizations: Array<{ service: string }> };
	baseUrl?: string;
}

function createLoadOptionsFns({ services, me, baseUrl = 'http://api:8099/' }: FakeOpts) {
	const calls: string[] = [];
	const fns = {
		async getCredentials() {
			return { baseUrl, clientId: 'c', clientSecret: 's' };
		},
		helpers: {
			async httpRequestWithAuthentication(_cred: string, opts: { url: string; baseURL: string }) {
				calls.push(`${opts.baseURL}${opts.url}`);
				if (opts.url === '/v1/services') return services;
				if (opts.url === '/v1/me') return me;
				throw new Error(`unexpected url ${opts.url}`);
			},
		},
		__calls: calls,
	};
	return fns as any;
}

test('getServices returns the intersection of API services and client authorizations, sorted', async () => {
	const fns = createLoadOptionsFns({
		services: [
			{ name: 'generation-render' },
			{ name: 'extract-text' },
			{ name: 'classify-document' },
			{ name: 'split-document' },
		],
		me: { authorizations: [{ service: 'extract-text' }, { service: 'classify-document' }] },
	});

	const result = await getServices.call(fns);

	assert.deepEqual(
		result.map((o) => o.value),
		['classify-document', 'extract-text'],
	);
});

test('getServices with "all" authorization returns every service', async () => {
	const fns = createLoadOptionsFns({
		services: [{ name: 'extract-text' }, { name: 'classify-document' }, { name: 'split-document' }],
		me: { authorizations: [{ service: 'all' }] },
	});

	const result = await getServices.call(fns);

	assert.deepEqual(
		result.map((o) => o.value),
		['classify-document', 'extract-text', 'split-document'],
	);
});

test('getServices with no authorization returns an empty list', async () => {
	const fns = createLoadOptionsFns({
		services: [{ name: 'extract-text' }, { name: 'classify-document' }],
		me: { authorizations: [] },
	});

	const result = await getServices.call(fns);

	assert.deepEqual(result, []);
});

test('getServices normalizes the base URL (no double slash)', async () => {
	const fns = createLoadOptionsFns({
		services: [{ name: 'extract-text' }],
		me: { authorizations: [{ service: 'extract-text' }] },
		baseUrl: 'http://api:8099/',
	});

	await getServices.call(fns);

	assert.ok(fns.__calls.includes('http://api:8099/v1/services'));
	assert.ok(fns.__calls.includes('http://api:8099/v1/me'));
});
