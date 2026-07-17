import { ILoadOptionsFunctions, INodePropertyOptions, IDataObject } from 'n8n-workflow';

const CREDENTIALS_NAME = 'asyncTaskApi';
/** Autorisation joker : le client a accès à *tous* les services. */
const ALL_SERVICES = 'all';

interface ServiceInfo {
	name: string;
	json_schema?: IDataObject | null;
}

interface Authorization {
	service: string;
}

interface MeResponse {
	client_id: string;
	authorizations: Authorization[];
}

/** Retire le(s) slash final(aux) de la base URL pour éviter les `//`. */
function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '');
}

/**
 * Alimente le dropdown « Service » : liste des services de l'API **intersectée**
 * avec les autorisations du client (`GET /v1/me`). Une autorisation `all` donne
 * accès à tous les services. Renvoie une liste triée ; vide si aucun service autorisé.
 */
export async function getServices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials(CREDENTIALS_NAME);
	const baseURL = normalizeBaseUrl(credentials.baseUrl as string);

	const [services, me] = await Promise.all([
		this.helpers.httpRequestWithAuthentication.call(this, CREDENTIALS_NAME, {
			method: 'GET',
			baseURL,
			url: '/v1/services',
			json: true,
		}) as Promise<ServiceInfo[]>,
		this.helpers.httpRequestWithAuthentication.call(this, CREDENTIALS_NAME, {
			method: 'GET',
			baseURL,
			url: '/v1/me',
			json: true,
		}) as Promise<MeResponse>,
	]);

	const authorized = new Set((me.authorizations ?? []).map((a) => a.service));
	const hasAllAccess = authorized.has(ALL_SERVICES);

	return services
		.filter((service) => hasAllAccess || authorized.has(service.name))
		.map((service) => ({ name: service.name, value: service.name }))
		.sort((a, b) => a.name.localeCompare(b.name));
}
