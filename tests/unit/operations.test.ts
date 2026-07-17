import test from 'node:test';
import assert from 'node:assert/strict';
import { getTask, submit, submitAndWait } from '../../nodes/asyncTask/operations';

const NODE = {
	name: 'AsyncTask',
	type: 'asyncTask',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

interface FakeExecOpts {
	params: Record<string, unknown>;
	responses?: unknown[];
	throwError?: unknown;
}

function createExecFns({ params, responses = [], throwError }: FakeExecOpts) {
	let call = 0;
	const requests: Array<{ method: string; url: string; body?: unknown }> = [];
	const fns = {
		getNode: () => NODE,
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		async getCredentials() {
			return { baseUrl: 'http://api', clientId: 'c', clientSecret: 's' };
		},
		helpers: {
			async httpRequestWithAuthentication(
				_cred: string,
				opts: { method: string; url: string; body?: unknown },
			) {
				requests.push({ method: opts.method, url: opts.url, body: opts.body });
				if (throwError) throw throwError;
				return responses[call++];
			},
		},
		__requests: requests,
	};
	return fns as any;
}

test('submit posts to the service tasks endpoint and returns the task data', async () => {
	const fns = createExecFns({
		params: { service: 'extract-text', body: { file_id: 'abc' } },
		responses: [{ status: 'success', data: { task_id: 't1', status: 'pending' } }],
	});

	const data = await submit(fns, 0);

	assert.equal(data.task_id, 't1');
	assert.equal(data.status, 'pending');
	assert.equal(fns.__requests[0].method, 'POST');
	assert.equal(fns.__requests[0].url, '/v1/services/extract-text/tasks');
	assert.deepEqual(fns.__requests[0].body, { body: { file_id: 'abc' } });
});

test('getTask fetches the task status endpoint and returns its data', async () => {
	const fns = createExecFns({
		params: { service: 'extract-text', taskId: 't1' },
		responses: [{ status: 'success', data: { task_id: 't1', status: 'success', result: { ok: 1 } } }],
	});

	const data = await getTask(fns, 0);

	assert.equal(data.status, 'success');
	assert.deepEqual(data.result, { ok: 1 });
	assert.equal(fns.__requests[0].method, 'GET');
	assert.equal(fns.__requests[0].url, '/v1/services/extract-text/tasks/t1');
});

test('submitAndWait polls until success and returns the result', async () => {
	const fns = createExecFns({
		params: { service: 'extract-text', body: {}, waitOptions: { pollIntervalSeconds: 0.01 } },
		responses: [
			{ status: 'success', data: { task_id: 't1', status: 'pending' } }, // submit
			{ status: 'success', data: { task_id: 't1', status: 'in_progress', progress: 0.5 } }, // poll 1
			{ status: 'success', data: { task_id: 't1', status: 'success', result: { text: 'ok' } } }, // poll 2
		],
	});

	const data = await submitAndWait(fns, 0);

	assert.equal(data.status, 'success');
	assert.deepEqual(data.result, { text: 'ok' });
});

test('submitAndWait throws an explicit error with the failure reason', async () => {
	const fns = createExecFns({
		params: { service: 'extract-text', body: {}, waitOptions: { pollIntervalSeconds: 0.01 } },
		responses: [
			{ status: 'success', data: { task_id: 't1', status: 'pending' } },
			{ status: 'success', data: { task_id: 't1', status: 'failure', error_message: 'PDF invalide' } },
		],
	});

	await assert.rejects(submitAndWait(fns, 0), /PDF invalide/);
});

test('submitAndWait times out with a "still running" message', async () => {
	const fns = createExecFns({
		params: {
			service: 'extract-text',
			body: {},
			waitOptions: { pollIntervalSeconds: 0.01, timeoutSeconds: 0.02 },
		},
		responses: [
			{ status: 'success', data: { task_id: 't1', status: 'pending' } },
			{ status: 'success', data: { task_id: 't1', status: 'in_progress' } },
			{ status: 'success', data: { task_id: 't1', status: 'in_progress' } },
			{ status: 'success', data: { task_id: 't1', status: 'in_progress' } },
			{ status: 'success', data: { task_id: 't1', status: 'in_progress' } },
		],
	});

	await assert.rejects(submitAndWait(fns, 0), /toujours en cours|délai dépassé/);
});

test('API errors are remapped to a readable message (SERVICE_FORBIDDEN)', async () => {
	const fns = createExecFns({
		params: { service: 'extract-text', body: {} },
		throwError: {
			httpCode: '403',
			response: { body: { status: 'error', error: { code: 'SERVICE_FORBIDDEN', message: 'nope' } } },
		},
	});

	await assert.rejects(submit(fns, 0), /autoris/i);
});
