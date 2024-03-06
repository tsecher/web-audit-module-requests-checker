import {AbstractPuppeteerJourneyModule} from 'web_audit/dist/journey/AbstractPuppeteerJourneyModule.js';
import {PuppeteerJourneyEvents} from 'web_audit/dist/journey/AbstractPuppeteerJourney.js';
import {ModuleEvents} from 'web_audit/dist/modules/ModuleInterface.js';

/**
 * Requests Checker Module events.
 */
export const RequestsCheckerModuleEvents = {
	createRequestsCheckerModule: 'requests_checker_module__createRequestsCheckerModule',
	beforeAnalyse: 'requests_checker_module__beforeAnalyse',
	onResult: 'requests_checker_module__onResult',
	onResultDetail: 'requests_checker_module__onResultDetail',
	afterAnalyse: 'requests_checker_module__afterAnalyse',
};

/**
 * Requests Checker.
 */
export default class RequestsCheckerModule extends AbstractPuppeteerJourneyModule {
	get name() {
		return 'Requests Checker';
	}

	get id() {
		return `requests_checker`;
	}

	contextsData = {};

	/**
	 * {@inheritdoc}
	 */
	async init(context) {
		this.context = context;
		// Install store.
		this.context.config.storage?.installStore('requests_checker', this.context, {
			url: 'Url',
			context: 'Context',
			nb: 'NB requests',
			ratioCacheControle: 'Cache Controle (%)',
			ratioHttp2: 'Http 2 (%)',
			secure: 'HTTPS (%)',
			badEncoded: 'Nb requests encoded > decoded',
			encoded: 'Encoded requests (%)',
		});

		// Install store detail.
		this.context.config.storage?.installStore('requests_checker_details', this.context, {
			url: 'Url',
			context: 'Context',
			src: 'Source',
			mimeType: 'Mime type',
			contentEncoding: 'Content Encoding',
			responseHeaderSize: 'Response Header Size',
			encodedDataLength: 'Encoded Data Length',
			decodedDataLength: 'Decoded Data Length',
			fromCache: 'From Cache',
			cacheControl: 'Cache Control',
			protocol: 'Protocol',
			securityState: 'Security State',
			securityProtocole: 'Security Protocole',
		});

		// Emit.
		this.context.eventBus.emit(RequestsCheckerModuleEvents.createRequestsCheckerModule, {module: this});
	}

	/**
	 * {@inheritdoc}
	 */
	initEvents(journey) {
		this.currentContextData = {};
		journey.on(PuppeteerJourneyEvents.JOURNEY_START, async (data) => this.initPuppeteerJourney(data));
		journey.on(PuppeteerJourneyEvents.JOURNEY_NEW_CONTEXT, async (data) => {
			this.contextsData[data.name] = this.currentContextData;
		});
	}

	/**
	 * {@inheritdoc}
	 */
	async analyse(urlWrapper) {
		this.context?.eventBus.emit(ModuleEvents.startsComputing, {module: this});
		for (const contextName in this.contextsData) {
			if (contextName) {
				this.analyseContext(contextName, urlWrapper);
			}
		}
		this.context?.eventBus.emit(ModuleEvents.endsComputing, {module: this});
		return true;
	}

	/**
	 * Analyse a context.
	 *
	 * @param {string} contextName
	 * @param {UrlWrapper} urlWrapper
	 */
	analyseContext(contextName, urlWrapper) {
		const eventData = {
			module: this,
			url: urlWrapper,
		};
		this.context?.eventBus.emit(RequestsCheckerModuleEvents.beforeAnalyse, eventData);
		this.context?.eventBus.emit(ModuleEvents.beforeAnalyse, eventData);

		for (let source of Object.values(this.contextsData[contextName])) {
			source.decodedDataLength = this.responseSizes[source.src]
			this.context?.config?.storage?.add('requests_checker_details', this.context,
				{
					url: urlWrapper.url.toString(),
					context: contextName,
					...source,
				});
		}

		// Event data.
		eventData.result = {
			url: urlWrapper.url.toString(),
			context: contextName,
			...this.getResult(Object.values(this.contextsData[contextName])),
		};

		this.context?.eventBus.emit(RequestsCheckerModuleEvents.onResult, eventData);
		this.context?.config?.logger.result(`Requests Checker`, eventData.result, urlWrapper.url.toString());
		this.context?.config?.storage?.add('requests_checker', this.context, eventData.result);
		this.context?.eventBus.emit(ModuleEvents.afterAnalyse, eventData);
		this.context?.eventBus.emit(RequestsCheckerModuleEvents.afterAnalyse, eventData);
	}


	async initPuppeteerJourney(data) {
		this.responsesMap = new Map();
		this.devTools = await data.wrapper.page.target().createCDPSession();
		await this.devTools.send('Network.clearBrowserCache');
		await this.devTools.send('Network.enable');
		this.devTools?.on('Network.loadingFinished', (event) => this.onNetworkLoadingFinished(event));
		this.devTools?.on('Network.responseReceived', (event) => this.onNetworkResponseReceived(event));

		// Puppeteer response.
		this.responseSizes = {};
		data.wrapper.page.on('response', async response => this.onResponse(response));
	}

	/**
	 * On devtools response received.
	 *
	 * @param event
	 */
	onNetworkResponseReceived(event) {
		this.responsesMap.set(event.requestId, event.response);
	};

	/**
	 * On devtools loading finished.
	 *
	 * @param event
	 */
	onNetworkLoadingFinished(event) {
		const response = this.responsesMap.get(event.requestId);

		if (response.protocol === 'data') {
			return;
		}

		this.requestsIds = (this.requestsIds || [])
		this.requestsIds.push(event.requestId);


		this.currentContextData[response.url] = this.currentContextData[response.url] || {};

		this.currentContextData[response.url] = {
			...this.currentContextData[response.url],
			...{
				src: response.url,
				status: response.status,
				mimeType: response.mimeType,
				contentEncoding: response.headers['Content-Encoding'] || response.headers['content-encoding'] || '',
				responseHeaderSize: event.encodedDataLength - (response.headers['Content-Length'] || response.headers['content-length']),
				encodedDataLength: response.headers['Content-Length'] || response.headers['content-length'],
				fromCache: response.fromDiskCache || response.fromServiceWorker || response.fromPrefetchCache,
				cacheControl: response.headers['Cache-Control'] || response.headers['cache-control'],
				protocol: response.protocol,
				securityState: response.securityState,
				securityProtocole: response.securityDetails?.protocol,
			}
		}
	}

	/**
	 * On puppeteer info.
	 * @param response
	 * @returns {Promise<void>}
	 */
	async onResponse(response) {
		if (response.ok()) {
			try {
				this.responseSizes[response.url()] = (await response.buffer()).length;
			} catch (e) {
				this.context?.config?.logger?.error(e);
			}
		}
	};

	/**
	 * Return result.
	 *
	 * @param data
	 * @returns {{badEncoded, nb, ratioCacheControle: number, secure: number, ratioHttp2: number, encoded: number}}
	 */
	getResult(data) {
		return {
			nb: data.length,
			ratioCacheControle: data.filter(item => item.cacheControl?.indexOf('max-age') > -1 && item.cacheControl?.indexOf('max-age=0') < 0).length / data.length,
			ratioHttp2: data.filter(item => item.protocol.indexOf('h2') > -1).length / data.length,
			secure: data.filter(item => item.securityState).length / data.length,
			badEncoded: data.filter(item => item.encodedDataLength > item.decodedDataLength).length,
			encoded: data.filter(item => item.contentEncoding.length).length / data.length,
		}
	}

}
