import {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';
import { getServices } from './services';

export class AsyncTask implements INodeType {
	methods = {
		loadOptions: {
			async getServices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return getServices.call(this);
			},
		},
	};

	description: INodeTypeDescription = {
		displayName: 'BRIO — Services IA',
		name: 'asyncTask',
		icon: 'file:asyncTask.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Soumettre des tâches aux services IA BRIO (async-api) et récupérer les résultats',
		defaults: {
			name: 'BRIO — Services IA',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'asyncTaskApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Envoyer Un Fichier',
						value: 'uploadFile',
						action: 'Envoyer un fichier et recuperer un file id',
					},
					{
						name: 'Recuperer Une Tache',
						value: 'get',
						action: 'Recuperer letat ou le resultat dune tache',
					},
					{
						name: 'Soumettre Et Attendre',
						value: 'submitAndWait',
						action: 'Soumettre une tache et attendre le resultat',
					},
					{
						name: 'Soumettre Une Tache',
						value: 'submit',
						action: 'Soumettre une tache et recuperer son identifiant',
					},
				],
				default: 'submitAndWait',
			},
			{
				displayName: 'Service Name or ID',
				name: 'service',
				type: 'options',
				noDataExpression: false,
				typeOptions: {
					loadOptionsMethod: 'getServices',
				},
				default: '',
				required: true,
				description:
					'Service BRIO à appeler. La liste est limitée à vos services autorisés. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						operation: ['submit', 'submitAndWait', 'get'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		// Socle (#484) : les opérations sont implémentées dans les tickets suivants
		// (#477 découverte, #478 submit, #479 get/submitAndWait, #480 fichiers).
		const operation = this.getNodeParameter('operation', 0) as string;
		throw new NodeOperationError(
			this.getNode(),
			`Opération « ${operation} » pas encore implémentée (socle en place, voir tickets #477–#480).`,
		);
	}
}
