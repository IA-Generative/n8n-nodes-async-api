import {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';
import { getServices } from './services';
import { getTask, submit, submitAndWait } from './operations';

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
			{
				displayName: 'Body (JSON)',
				name: 'body',
				type: 'json',
				default: '{}',
				description:
					"Paramètres de la tâche, conformes au JSON Schema du service choisi (visible via GET /v1/services). Validé par l'API : un corps non conforme renvoie un message indiquant le champ en erreur.",
				displayOptions: {
					show: {
						operation: ['submit', 'submitAndWait'],
					},
				},
			},
			{
				displayName: 'Task ID',
				name: 'taskId',
				type: 'string',
				default: '',
				required: true,
				description: "Identifiant de la tâche à interroger (retourné par l'opération de soumission)",
				displayOptions: {
					show: {
						operation: ['get'],
					},
				},
			},
			{
				displayName: 'Options D\'attente',
				name: 'waitOptions',
				type: 'collection',
				placeholder: 'Ajouter une option',
				default: {},
				displayOptions: {
					show: {
						operation: ['submitAndWait'],
					},
				},
				options: [
					{
						displayName: 'Fréquence De vérification (Secondes)',
						name: 'pollIntervalSeconds',
						type: 'number',
						default: 5,
						typeOptions: { minValue: 1 },
						description: 'Intervalle entre deux vérifications du statut',
					},
					{
						displayName: 'Délai Max (Secondes)',
						name: 'timeoutSeconds',
						type: 'number',
						default: 300,
						typeOptions: { minValue: 1 },
						description: "Au-delà, le nœud s'arrête avec un message « toujours en cours »",
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;
			let data: IDataObject;
			switch (operation) {
				case 'submit':
					data = (await submit(this, i)) as unknown as IDataObject;
					break;
				case 'submitAndWait':
					data = (await submitAndWait(this, i)) as unknown as IDataObject;
					break;
				case 'get':
					data = (await getTask(this, i)) as unknown as IDataObject;
					break;
				case 'uploadFile':
					// #480 (fichiers) — livré dans un ticket ultérieur.
					throw new NodeOperationError(
						this.getNode(),
						"L'opération « Envoyer un fichier » sera disponible dans un prochain ticket (#480).",
						{ itemIndex: i },
					);
				default:
					throw new NodeOperationError(this.getNode(), `Opération inconnue : ${operation}`, {
						itemIndex: i,
					});
			}
			returnData.push({ json: data, pairedItem: { item: i } });
		}

		return [returnData];
	}
}
