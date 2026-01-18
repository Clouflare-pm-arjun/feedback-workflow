# Feedback Workflow Worker

The Feedback Workflow Worker processes feedback from the aggregator worker using Cloudflare AI to extract themes, urgency, value, and sentiment. The processed feedback is then stored in R2 storage for downstream analysis and reporting.

## Architecture

```
Aggregator Worker → POST /process → Workflow Worker
                                        ↓
                                    [In-Memory Queue]
                                        ↓
                                [Process Queue Items]
                                        ↓
                                    [Cloudflare AI]
                        Extract: themes, urgency, value, sentiment
                                        ↓
                                    [R2 Storage]
                        Store: feedback-{id}.json (extracted + raw)
```

### Components

- **In-Memory Queue**: Temporarily stores feedback items for processing
- **Cloudflare AI**: Extracts themes, urgency, value, and sentiment from feedback
- **R2 Storage**: Persists processed feedback with extracted metadata

## Technology Stack

- **Cloudflare Workers**: Serverless runtime for the worker
- **Workers AI**: AI inference using `@cf/meta/llama-3-8b-instruct`
- **R2 Storage**: Object storage for processed feedback

## Setup Instructions

### Prerequisites

- Cloudflare account with Workers AI access
- Wrangler CLI installed: `npm install -g wrangler`
- Node.js and npm

### 1. Create R2 Bucket

Create an R2 bucket to store processed feedback:

```bash
wrangler r2 bucket create feedback-processed
```

### 2. Configuration

#### Update `wrangler.jsonc`

The `wrangler.jsonc` file is already configured with:
- R2 bucket binding (`FEEDBACK_STORAGE`)
- Environment variable for `CF_ACCOUNT_ID`

Update the bucket name if you used a different name:

```jsonc
"r2_buckets": [
  {
    "binding": "FEEDBACK_STORAGE",
    "bucket_name": "your-bucket-name"
  }
]
```

#### Set Environment Variables

1. **Set Account ID** (already configured in `wrangler.jsonc`):
   ```jsonc
   "vars": {
     "CF_ACCOUNT_ID": "your-account-id"
   }
   ```

2. **Set API Token as Secret**:
   ```bash
   wrangler secret put CF_API_TOKEN
   ```
   Enter your Cloudflare API token when prompted.

### 3. Installation

Install dependencies:

```bash
npm install
```

### 4. Deployment

Deploy the worker:

```bash
npm run deploy
```

Or use Wrangler directly:

```bash
wrangler deploy
```

## Configuration

### Environment Variables

- **`CF_ACCOUNT_ID`** (required): Cloudflare account ID
  - Set in `wrangler.jsonc` under `vars.CF_ACCOUNT_ID`
  
- **`CF_API_TOKEN`** (required): Cloudflare API token for AI API access
  - Must be set as a Wrangler secret: `wrangler secret put CF_API_TOKEN`
  - Never commit tokens to version control

### R2 Bucket Binding

The R2 bucket is bound in `wrangler.jsonc`:

```jsonc
"r2_buckets": [
  {
    "binding": "FEEDBACK_STORAGE",
    "bucket_name": "feedback-processed"
  }
]
```

The bucket name can be changed, but ensure it matches the bucket created in step 1.

## API Endpoints

### POST /process

Accepts feedback from the aggregator worker and queues it for processing.

**Request Body:**
```json
{
  "id": "fb-1234567890-abc123",
  "source": "support",
  "source_id": "TICKET-12345",
  "title": "Slow API response times",
  "content": "We are experiencing very slow response times...",
  "author": "john.doe@company.com",
  "author_email": "john.doe@company.com",
  "status": "pending",
  "metadata": {
    "priority": "high",
    "category": "performance"
  },
  "created_at": 1704067200,
  "updated_at": 1704067200
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Feedback queued for processing",
  "queueLength": 1
}
```

**Error Responses:**
- `400 Bad Request`: Invalid feedback data (missing required fields)
- `500 Internal Server Error`: Failed to queue feedback

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "service": "feedback-workflow"
}
```

### GET /queue/status

Get current queue status and length.

**Response:**
```json
{
  "queueLength": 5,
  "status": "operational"
}
```

### GET /

Root endpoint that lists available endpoints.

**Response:**
```json
{
  "service": "feedback-workflow",
  "endpoints": {
    "POST /process": "Queue feedback for processing",
    "GET /health": "Health check",
    "GET /queue/status": "Get queue status"
  }
}
```

## Data Processing

### In-Memory Queue

Feedback items are stored in an in-memory array for processing:
- **Ephemeral**: Queue is per-worker instance and not persistent
- **FIFO**: Items are processed in first-in-first-out order
- **Background Processing**: Items are processed asynchronously after being queued

### AI Processing

The worker uses Cloudflare Workers AI with the `@cf/meta/llama-3-8b-instruct` model to extract:
- **Themes**: Relevant Cloudflare-related themes from predefined list
- **Urgency**: Urgency level (low, medium, high, critical)
- **Value**: Numeric score (0-100) indicating feedback importance
- **Sentiment**: Sentiment classification (positive, neutral, negative)

**AI API Endpoint:**
```
https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/meta/llama-3-8b-instruct
```

### Storage

Processed feedback is stored in R2 as JSON files:
- **File Naming**: `feedback-{id}.json`
- **Content Type**: `application/json`
- **Structure**: Contains both raw feedback and extracted data

## Extracted Data Structure

The `ProcessedFeedback` interface extends the base `Feedback` interface with extracted data:

```typescript
interface ProcessedFeedback extends Feedback {
  extracted: {
    themes: string[];              // Array of theme strings from predefined list
    urgency: 'low' | 'medium' | 'high' | 'critical';
    value: number;                 // Numeric score (0-100)
    sentiment: 'positive' | 'neutral' | 'negative';
  };
}
```

### Raw Feedback Fields

- `id`: Unique feedback identifier
- `source`: Source system (support, discord, github, email, twitter, forum)
- `source_id`: Original ID from source system
- `title`: Feedback title/subject
- `content`: Feedback content
- `author`: Username or identifier
- `author_email`: Author email if available
- `status`: Processing status
- `metadata`: Source-specific metadata
- `created_at`: Unix timestamp
- `updated_at`: Unix timestamp

### Extracted Data Fields

- **`themes`**: Array of strings from predefined Cloudflare themes list
- **`urgency`**: One of `'low'`, `'medium'`, `'high'`, or `'critical'`
- **`value`**: Number between 0-100 representing feedback importance/value
- **`sentiment`**: One of `'positive'`, `'neutral'`, or `'negative'`

## Predefined Cloudflare Themes

The AI extracts themes from this predefined list:

- Workers
- R2
- D1
- KV
- Pages
- AI
- CDN
- Security
- Performance
- DNS
- SSL/TLS
- Analytics
- Streaming
- API
- Edge Computing
- WAF
- Rate Limiting
- Zero Trust

Themes are matched from the feedback content and must exactly match items in this list.

## R2 Storage Structure

### File Naming

Files are stored with the naming convention: `feedback-{id}.json`

Example: `feedback-fb-1234567890-abc123.json`

### File Format

Each file contains a complete `ProcessedFeedback` object as JSON:

```json
{
  "id": "fb-1234567890-abc123",
  "source": "support",
  "content": "...",
  "title": "...",
  ...,
  "extracted": {
    "themes": ["Workers", "Performance"],
    "urgency": "high",
    "value": 85,
    "sentiment": "negative"
  }
}
```

### Bucket Structure

The R2 bucket uses a flat structure with filenames as keys:
```
feedback-processed/
├── feedback-fb-1234567890-abc123.json
├── feedback-fb-1234567891-def456.json
└── ...
```

## Error Handling

### AI API Failures

- **Logging**: Errors are logged to console
- **Fallback**: Default values are used if AI extraction fails
  - `themes`: Empty array
  - `urgency`: `'medium'`
  - `value`: `50`
  - `sentiment`: `'neutral'`
- **Continuation**: Processing continues for other queue items

### R2 Write Failures

- **Logging**: Errors are logged to console
- **Error Propagation**: R2 write errors are caught and logged
- **Continuation**: Processing continues for other queue items

### Queue Processing

- **Background Processing**: Uses `ctx.waitUntil()` to ensure processing completes
- **Error Isolation**: Errors in one item don't stop processing of others
- **Retry**: Not implemented (future improvement)

## Development

### Local Development

Run the worker locally:

```bash
npm run dev
```

Or with Wrangler:

```bash
wrangler dev
```

### Testing

Test with sample feedback using curl:

```bash
curl -X POST http://localhost:8787/process \
  -H "Content-Type: application/json" \
  -d '{
    "id": "fb-test-123",
    "source": "support",
    "content": "The Workers API is too slow for our use case",
    "title": "Performance Issue",
    "created_at": 1704067200,
    "updated_at": 1704067200
  }'
```

Check queue status:

```bash
curl http://localhost:8787/queue/status
```

### Logging

The worker uses `console.log()` and `console.error()` for logging:
- Processing status
- Error messages
- R2 storage confirmations
- AI extraction results

View logs in Wrangler dashboard or with:

```bash
wrangler tail
```

## Limitations & Future Improvements

### Current Limitations

1. **In-Memory Queue**: 
   - Queue is ephemeral and per-worker instance
   - Not persistent across worker restarts
   - Items may be lost if worker restarts during processing

2. **No Retry Logic**:
   - Failed AI extractions use default values
   - Failed R2 writes are logged but not retried

3. **Sequential Processing**:
   - Items are processed one at a time
   - No parallel processing for throughput optimization

4. **No Monitoring**:
   - Limited metrics for queue length and processing time
   - No alerting for failures

### Future Improvements

1. **Persistent Queue**:
   - Use Durable Objects for queue persistence
   - Or integrate with Cloudflare Queues (paid feature)

2. **Retry Logic**:
   - Implement retry for failed AI extractions
   - Implement retry for failed R2 writes with exponential backoff

3. **Parallel Processing**:
   - Process multiple queue items concurrently
   - Control concurrency with configurable limits

4. **Monitoring & Metrics**:
   - Add metrics for queue length, processing time, error rates
   - Integrate with Cloudflare Analytics
   - Add alerting for error thresholds

5. **Enhanced AI Extraction**:
   - Improve prompt engineering for better extraction accuracy
   - Add validation for extracted data
   - Support custom theme lists

## Integration with Aggregator Worker

The workflow worker is designed to be called by the aggregator worker:

### Request Flow

1. **Aggregator receives feedback** → Stores in D1
2. **Aggregator calls workflow** → `POST /process` with feedback JSON
3. **Workflow queues feedback** → Returns 200 OK immediately
4. **Workflow processes asynchronously** → Extracts data using AI
5. **Workflow stores to R2** → Saves processed feedback

### Expected Request Format

The aggregator sends feedback in the same format it stores in D1:

```json
{
  "id": "fb-...",
  "source": "...",
  "content": "...",
  ...
}
```

### Response Format

The workflow returns immediately with a 200 OK response:

```json
{
  "success": true,
  "message": "Feedback queued for processing",
  "queueLength": 1
}
```

### Error Handling Between Services

- **Network Errors**: Aggregator should retry failed requests
- **Validation Errors**: Workflow returns 400 with error details
- **Server Errors**: Workflow returns 500 with error details
- **Timeouts**: Aggregator should handle request timeouts appropriately

## Examples

### Example Feedback Payload

```json
{
  "id": "fb-1704067200-abc123",
  "source": "github",
  "source_id": "github-issue-123",
  "title": "R2 bucket access is slow",
  "content": "We've noticed that accessing R2 buckets from Workers has significant latency. This is impacting our application performance.",
  "author": "developer@example.com",
  "author_email": "developer@example.com",
  "status": "pending",
  "metadata": {
    "repository": "myrepo",
    "issue_number": 123
  },
  "created_at": 1704067200,
  "updated_at": 1704067200
}
```

### Example Processed Feedback Output

After processing, the R2 stored file contains:

```json
{
  "id": "fb-1704067200-abc123",
  "source": "github",
  "source_id": "github-issue-123",
  "title": "R2 bucket access is slow",
  "content": "We've noticed that accessing R2 buckets from Workers has significant latency...",
  "author": "developer@example.com",
  "author_email": "developer@example.com",
  "status": "processed",
  "metadata": {
    "repository": "myrepo",
    "issue_number": 123
  },
  "created_at": 1704067200,
  "updated_at": 1704070800,
  "extracted": {
    "themes": ["R2", "Workers", "Performance"],
    "urgency": "high",
    "value": 80,
    "sentiment": "negative"
  }
}
```

### Example curl Commands

Test the process endpoint:

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/process \
  -H "Content-Type: application/json" \
  -d @feedback-example.json
```

Check health:

```bash
curl https://your-worker.your-subdomain.workers.dev/health
```

Check queue status:

```bash
curl https://your-worker.your-subdomain.workers.dev/queue/status
```

## Troubleshooting

### R2 Bucket Not Found

**Error**: `R2 bucket not found` or `FEEDBACK_STORAGE is undefined`

**Solution**:
1. Ensure bucket exists: `wrangler r2 bucket list`
2. Verify bucket name in `wrangler.jsonc` matches created bucket
3. Re-deploy worker after creating bucket

### AI API Authentication Failures

**Error**: `401 Unauthorized` or `AI API error: 401`

**Solution**:
1. Verify `CF_API_TOKEN` secret is set: `wrangler secret list`
2. Check token has Workers AI permissions
3. Regenerate token if needed and update secret

### Queue Not Processing Items

**Symptoms**: Items added to queue but not processed

**Solution**:
1. Check worker logs: `wrangler tail`
2. Verify AI API is accessible and credentials are correct
3. Check R2 bucket permissions
4. Ensure worker is running and not timing out

### R2 Write Failures

**Error**: `Error storing feedback to R2` in logs

**Solution**:
1. Verify R2 bucket binding is correct in `wrangler.jsonc`
2. Check bucket permissions in Cloudflare dashboard
3. Verify bucket exists and is accessible
4. Check worker logs for detailed error messages

### AI Extraction Returns Default Values

**Symptoms**: All feedback has same extracted values (themes: [], urgency: medium, etc.)

**Solution**:
1. Check AI API response in logs
2. Verify AI API endpoint is correct
3. Check prompt formatting and AI response parsing
4. Test AI API directly with curl to verify it's working

### Worker Timeout Issues

**Symptoms**: Requests timeout before processing completes

**Solution**:
1. Check worker CPU time limits
2. Optimize AI API calls (may need to reduce payload size)
3. Consider processing items in batches
4. Check worker logs for timeout errors

## References

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Workers AI Documentation](https://developers.cloudflare.com/workers-ai/)
- [Workers AI Models](https://developers.cloudflare.com/workers-ai/models/)
- [R2 API Documentation](https://developers.cloudflare.com/r2/)
- [Wrangler Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

## License

Copyright 2024, Cloudflare. Apache 2.0 licensed. See the LICENSE file for details.
