import test from 'node:test';
import assert from 'node:assert/strict';
import {
	getTask,
	presignedDownload,
	presignedUpload,
	submit,
	submitAndWait,
	uploadFile,
} from '../../nodes/asyncTask/operations';

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

test('submit parses a JSON string body into an object', async () => {
	const fns = createExecFns({
		params: { service: 'extract-text', body: '{"file_id":"abc"}' },
		responses: [{ status: 'success', data: { task_id: 't1', status: 'pending' } }],
	});

	await submit(fns, 0);

	assert.deepEqual(fns.__requests[0].body, { body: { file_id: 'abc' } });
});

test('submit throws a clear error on malformed JSON body', async () => {
	const fns = createExecFns({
		params: { service: 'extract-text', body: '{not json' },
		responses: [{ status: 'success', data: { task_id: 't1', status: 'pending' } }],
	});

	await assert.rejects(submit(fns, 0), /mal formé|invalide/i);
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

// ---- Fichiers (#480) ----

function createFileExecFns(params: Record<string, unknown>, opts: {
	buffer?: Buffer;
	binaryMeta?: { fileName: string; mimeType: string };
	authResponses?: Record<string, unknown>;
	httpResponse?: unknown;
}) {
	const authCalls: Array<{ url: string; body?: unknown }> = [];
	const httpCalls: Array<{ url: string; method?: string; body?: unknown }> = [];
	const fns = {
		getNode: () => NODE,
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		async getCredentials() {
			return { baseUrl: 'http://api', clientId: 'c', clientSecret: 's' };
		},
		helpers: {
			assertBinaryData: (_i: number, _p: string) =>
				opts.binaryMeta ?? { fileName: 'doc.pdf', mimeType: 'application/pdf' },
			getBinaryDataBuffer: async (_i: number, _p: string) => opts.buffer ?? Buffer.from('data'),
			async httpRequestWithAuthentication(_cred: string, o: { url: string; body?: unknown }) {
				authCalls.push({ url: o.url, body: o.body });
				return (opts.authResponses ?? {})[o.url];
			},
			async httpRequest(o: { url: string; method?: string; body?: unknown }) {
				httpCalls.push({ url: o.url, method: o.method, body: o.body });
				return opts.httpResponse;
			},
			prepareBinaryData: async (buffer: Buffer, fileName: string) => ({
				fileName,
				data: buffer.toString('base64'),
				mimeType: 'application/octet-stream',
			}),
		},
		__authCalls: authCalls,
		__httpCalls: httpCalls,
	};
	return fns as any;
}

test('uploadFile posts multipart to /storage/upload and returns file_id', async () => {
	const fns = createFileExecFns(
		{ binaryPropertyName: 'data' },
		{ authResponses: { '/storage/upload': { file_id: 'c/uuid/doc.pdf' } } },
	);

	const res = await uploadFile(fns, 0);

	assert.equal(res.file_id, 'c/uuid/doc.pdf');
	assert.equal(fns.__authCalls[0].url, '/storage/upload');
	// le body est un FormData contenant le champ "file"
	assert.ok((fns.__authCalls[0].body as FormData).get('file'));
});

test('presignedUpload requests a presigned POST then uploads to S3, returns file_id', async () => {
	const fns = createFileExecFns(
		{ binaryPropertyName: 'data' },
		{
			authResponses: {
				'/storage/presigned-upload': {
					url: 'https://s3.example/bucket',
					fields: { key: 'c/uuid/doc.pdf', policy: 'xxx' },
					file_id: 'c/uuid/doc.pdf',
				},
			},
		},
	);

	const res = await presignedUpload(fns, 0);

	assert.equal(res.file_id, 'c/uuid/doc.pdf');
	assert.equal(fns.__authCalls[0].url, '/storage/presigned-upload');
	// upload direct S3 via httpRequest (sans auth)
	assert.equal(fns.__httpCalls[0].url, 'https://s3.example/bucket');
	const s3Body = fns.__httpCalls[0].body as FormData;
	assert.ok(s3Body.get('file'));
	assert.equal(s3Body.get('key'), 'c/uuid/doc.pdf');
});

test('presignedDownload fetches the presigned URL and returns binary', async () => {
	const fns = createFileExecFns(
		{ fileId: 'c/uuid/result.pdf', binaryPropertyName: 'data' },
		{
			authResponses: { '/storage/presigned-download': { url: 'https://s3.example/get' } },
			httpResponse: { body: Buffer.from('PDFDATA') },
		},
	);

	const item = await presignedDownload(fns, 0);

	assert.equal(item.json.file_id, 'c/uuid/result.pdf');
	assert.ok(item.binary?.data);
	assert.equal(item.binary?.data.fileName, 'result.pdf');
	assert.equal(fns.__httpCalls[0].url, 'https://s3.example/get');
});
