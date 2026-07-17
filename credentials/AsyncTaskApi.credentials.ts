import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class AsyncTaskApi implements ICredentialType {
	name = 'asyncTaskApi';

	// eslint-disable-next-line n8n-nodes-base/cred-class-field-display-name-missing-api
	displayName = 'AsyncTaskAPI (BRIO)';

	documentationUrl = 'https://github.com/IA-Generative/n8n-nodes-async-api';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://async-api-staging.sdid-app-hp.cpin.numerique-interieur.com',
			description: "URL de base de l'API async-api (sans slash final)",
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			description: 'Identifiant du client (authentification HTTP Basic)',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description: 'Secret du client (authentification HTTP Basic)',
		},
	];

	// Injecte automatiquement l'entête HTTP Basic sur toutes les requêtes du nœud.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			auth: {
				username: '={{$credentials.clientId}}',
				password: '={{$credentials.clientSecret}}',
			},
		},
	};

	// Teste réellement les identifiants : GET /v1/me est le seul endpoint client,
	// authentifié, sans paramètre ni effet de bord (renvoie 401 si identifiants invalides).
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/me',
		},
	};
}
