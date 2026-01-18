/**
 * Feedback Workflow Worker
 * 
 * This worker receives feedback from the aggregator worker, processes it using
 * Cloudflare AI to extract themes, urgency, value, and sentiment, then stores
 * the processed feedback in R2 storage using Cloudflare Workflows.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

/**
 * Feedback interface matching the aggregator's Feedback structure
 */
interface Feedback {
	id: string;
	source: 'support' | 'discord' | 'github' | 'email' | 'twitter' | 'forum';
	source_id?: string;
	title?: string;
	content: string;
	author?: string;
	author_email?: string;
	status?: 'pending' | 'processing' | 'processed';
	metadata?: Record<string, any>;
	created_at: number;
	updated_at: number;
}

/**
 * Processed feedback with extracted data
 */
interface ProcessedFeedback extends Feedback {
	extracted: {
		themes: string[]; // Array of theme strings from predefined list
		urgency: 'low' | 'medium' | 'high' | 'critical';
		value: number; // Numeric score (0-100)
		sentiment: 'positive' | 'neutral' | 'negative';
	};
}

/**
 * Environment bindings
 */
interface Env {
	FEEDBACK_WORKFLOW: Workflow; // Workflow binding
	FEEDBACK_STORAGE: R2Bucket; // R2 bucket for storing processed feedback
	CF_ACCOUNT_ID: string; // Cloudflare account ID for AI API
	CF_API_TOKEN: string; // Cloudflare API token (stored as secret)
	ASSETS?: Fetcher; // Static assets binding for OpenAPI spec (optional)
}

/**
 * Predefined Cloudflare-related themes
 */
const CLOUDFLARE_THEMES = [
	'Workers',
	'R2',
	'D1',
	'KV',
	'Pages',
	'AI',
	'CDN',
	'Security',
	'Performance',
	'DNS',
	'SSL/TLS',
	'Analytics',
	'Streaming',
	'API',
	'Edge Computing',
	'WAF',
	'Rate Limiting',
	'Zero Trust',
];

/**
 * FeedbackWorkflow class that processes feedback using Cloudflare AI
 */
export class FeedbackWorkflow extends WorkflowEntrypoint<Env, Feedback> {
	async run(event: WorkflowEvent<Feedback>, step: WorkflowStep) {
		const feedback = event.payload;

		console.log(`Starting workflow for feedback: ${feedback.id}`);

		// Step 1: Extract feedback data using AI
		const extracted = await step.do('extract-feedback-data', async () => {
			return await this.extractFeedbackData(feedback);
		});

		// Step 2: Create processed feedback object
		// Note: Keep original status - don't change it to 'processed' in R2
		// Status in R2 will be controlled separately via UI
		const processedFeedback: ProcessedFeedback = await step.do('create-processed-feedback', async () => {
			return {
				...feedback,
				extracted,
				// Keep original status from feedback (don't override)
				updated_at: Math.floor(Date.now() / 1000),
			};
		});

		// Step 3: Store processed feedback to R2
		await step.do('store-to-r2', {
			retries: {
				limit: 3,
				delay: '5 second',
				backoff: 'exponential',
			},
			timeout: '5 minutes',
		}, async () => {
			await this.storeToR2(processedFeedback);
		});

		console.log(`Successfully processed feedback: ${feedback.id}`);
		return { success: true, feedbackId: feedback.id };
	}

	/**
	 * Extract feedback data using Cloudflare AI
	 */
	private async extractFeedbackData(feedback: Feedback): Promise<{
		themes: string[];
		urgency: 'low' | 'medium' | 'high' | 'critical';
		value: number;
		sentiment: 'positive' | 'neutral' | 'negative';
	}> {
		const themesList = CLOUDFLARE_THEMES.join(', ');

		const systemPrompt = `You are a feedback analysis assistant. Analyze the following feedback and extract:
1. Themes: Select relevant themes from this predefined list (return as comma-separated values): ${themesList}
2. Urgency: Determine urgency level (low, medium, high, or critical)
3. Value: Score the value/importance of this feedback from 0-100 (where 0 is low value and 100 is high value)
4. Sentiment: Determine sentiment (positive, neutral, or negative)

Return your response as a JSON object with these exact keys: themes (array), urgency (string), value (number), sentiment (string).

Example format:
{
  "themes": ["Workers", "Performance"],
  "urgency": "medium",
  "value": 75,
  "sentiment": "neutral"
}`;

		const userPrompt = `Feedback Title: ${feedback.title || 'N/A'}
Feedback Content: ${feedback.content}
Source: ${feedback.source}
Author: ${feedback.author || 'N/A'}

Analyze this feedback and provide the extracted data in JSON format.`;

		const aiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3-8b-instruct`;

		try {
			const response = await fetch(aiUrl, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.env.CF_API_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: userPrompt },
					],
				}),
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => 'Unknown error');
				throw new Error(`AI API error: ${response.status} - ${errorText}`);
			}

			const aiResponse = await response.json() as { result?: { response?: string }; response?: string };
			const aiText = aiResponse.result?.response || aiResponse.response || '';

			// Parse JSON from AI response (may be wrapped in text)
			let extractedData: any;
			try {
				// Try to find JSON in the response
				const jsonMatch = aiText.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					extractedData = JSON.parse(jsonMatch[0]);
				} else {
					throw new Error('No JSON found in AI response');
				}
			} catch (parseError) {
				// Fallback: create default structure
				console.warn('Failed to parse AI response as JSON, using defaults:', parseError);
				extractedData = {
					themes: [],
					urgency: 'medium',
					value: 50,
					sentiment: 'neutral',
				};
			}

			// Validate and normalize extracted data
			const themes = Array.isArray(extractedData.themes)
				? extractedData.themes.filter((theme: string) => CLOUDFLARE_THEMES.includes(theme))
				: typeof extractedData.themes === 'string'
					? extractedData.themes.split(',').map((t: string) => t.trim()).filter((t: string) => CLOUDFLARE_THEMES.includes(t))
					: [];

			const urgency = ['low', 'medium', 'high', 'critical'].includes(extractedData.urgency)
				? extractedData.urgency
				: 'medium';

			const value = typeof extractedData.value === 'number'
				? Math.max(0, Math.min(100, Math.round(extractedData.value)))
				: 50;

			const sentiment = ['positive', 'neutral', 'negative'].includes(extractedData.sentiment)
				? extractedData.sentiment
				: 'neutral';

			return { themes, urgency, value, sentiment };
		} catch (error) {
			console.error('Error extracting feedback data:', error);
			// Return default values on error
			return {
				themes: [],
				urgency: 'medium',
				value: 50,
				sentiment: 'neutral',
			};
		}
	}

	/**
	 * Store processed feedback to R2
	 */
	private async storeToR2(processedFeedback: ProcessedFeedback): Promise<void> {
		const key = `feedback-${processedFeedback.id}.json`;
		const jsonData = JSON.stringify(processedFeedback, null, 2);

		try {
			await this.env.FEEDBACK_STORAGE.put(key, jsonData, {
				httpMetadata: {
					contentType: 'application/json',
				},
			});
			console.log(`Stored processed feedback to R2: ${key}`);
		} catch (error) {
			console.error(`Error storing feedback ${processedFeedback.id} to R2:`, error);
			throw error;
		}
	}
}

/**
 * Handle POST /process - Create workflow instance for feedback
 */
async function handleProcess(request: Request, env: Env): Promise<Response> {
	try {
		const feedback: Feedback = await request.json();

		// Validate required fields
		if (!feedback.id || !feedback.content || !feedback.source) {
			return Response.json(
				{ error: 'Invalid feedback data. Required: id, content, source' },
				{ status: 400 }
			);
		}

		// Create workflow instance with feedback as payload
		const instance = await env.FEEDBACK_WORKFLOW.create({
			id: `feedback-${feedback.id}`,
			params: feedback,
		});

		return Response.json({
			success: true,
			message: 'Feedback workflow started',
			instanceId: instance.id,
			feedbackId: feedback.id,
		}, { status: 200 });
	} catch (error) {
		console.error('Error starting workflow:', error);
		return Response.json(
			{ error: 'Failed to start workflow', details: error instanceof Error ? error.message : 'Unknown error' },
			{ status: 500 }
		);
	}
}

/**
 * Handle GET /health - Health check
 */
function handleHealth(): Response {
	return Response.json({
		status: 'ok',
		service: 'feedback-workflow',
	});
}

/**
 * Serve Swagger UI documentation
 */
function serveSwaggerUI(baseUrl: string): Response {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Feedback Workflow API Documentation</title>
	<link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.10.3/swagger-ui.css" />
	<style>
		html {
			box-sizing: border-box;
			overflow: -moz-scrollbars-vertical;
			overflow-y: scroll;
		}
		*, *:before, *:after {
			box-sizing: inherit;
		}
		body {
			margin:0;
			background: #fafafa;
		}
	</style>
</head>
<body>
	<div id="swagger-ui"></div>
	<script src="https://unpkg.com/swagger-ui-dist@5.10.3/swagger-ui-bundle.js"></script>
	<script src="https://unpkg.com/swagger-ui-dist@5.10.3/swagger-ui-standalone-preset.js"></script>
	<script>
		window.onload = function() {
			const ui = SwaggerUIBundle({
				url: "${baseUrl}/openapi.yaml",
				dom_id: '#swagger-ui',
				deepLinking: true,
				presets: [
					SwaggerUIBundle.presets.apis,
					SwaggerUIStandalonePreset
				],
				plugins: [
					SwaggerUIBundle.plugins.DownloadUrl
				],
				layout: "StandaloneLayout",
				validatorUrl: null,
				tryItOutEnabled: true
			});
		};
	</script>
</body>
</html>`;

	return new Response(html, {
		headers: {
			'Content-Type': 'text/html',
		},
	});
}

/**
 * Serve OpenAPI spec
 */
async function serveOpenAPISpec(env: Env, baseUrl: string): Promise<Response> {
	// Try to serve from static assets first
	if (env.ASSETS) {
		try {
			const specResponse = await env.ASSETS.fetch(new URL(`${baseUrl}/openapi.yaml`));
			if (specResponse.ok) {
				return new Response(specResponse.body, {
					headers: {
						'Content-Type': 'application/x-yaml',
					},
				});
			}
		} catch (error) {
			console.warn('Failed to serve OpenAPI spec from assets:', error);
		}
	}
	
	// Fallback: return JSON with instructions
	return Response.json({
		message: 'OpenAPI spec file not found. Please ensure openapi.yaml is in the public directory.',
		spec_url: `${baseUrl}/openapi.yaml`,
	}, {
		headers: {
			'Content-Type': 'application/json',
		},
	});
}

/**
 * Main fetch handler
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method;
		const baseUrl = `${url.protocol}//${url.host}`;

		// Swagger UI documentation
		if (url.pathname === '/docs' || url.pathname === '/docs/') {
			return serveSwaggerUI(baseUrl);
		}

		// OpenAPI spec endpoint
		if (url.pathname === '/openapi.yaml' || url.pathname === '/openapi.json') {
			return serveOpenAPISpec(env, baseUrl);
		}

		// Health check endpoint
		if (url.pathname === '/health' || url.pathname === '/health/') {
			return handleHealth();
		}

		// Process endpoint
		if (url.pathname === '/process' || url.pathname === '/process/') {
			if (method === 'POST') {
				return handleProcess(request, env);
			} else {
				return Response.json({ error: 'Method not allowed' }, { status: 405 });
			}
		}

		// Root endpoint
		if (url.pathname === '/' || url.pathname === '') {
			return Response.json({
				service: 'feedback-workflow',
				endpoints: {
					'POST /process': 'Start workflow to process feedback',
					'GET /health': 'Health check',
					'GET /docs': 'Interactive API documentation (Swagger UI)',
					'GET /openapi.yaml': 'OpenAPI specification (YAML)',
				},
			});
		}

		return Response.json({ error: 'Not found' }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
