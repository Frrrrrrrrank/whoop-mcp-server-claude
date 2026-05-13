import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { WhoopApiClient } from './whoop-api.js';

const paginationProps = {
  limit: { type: 'number' as const, description: 'Limit (max 25)' },
  start: { type: 'string' as const, description: 'ISO 8601 start filter' },
  end: { type: 'string' as const, description: 'ISO 8601 end filter' },
  nextToken: { type: 'string' as const, description: 'Pagination token' },
};

const tools: Tool[] = [
  {
    name: 'whoop_get_user_profile',
    description: 'Get basic WHOOP user profile (name, email, user_id) for the authenticated user',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'whoop_get_user_body_measurements',
    description: 'Get body measurements (height, weight, max heart rate) for the authenticated user',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'whoop_get_cycle_collection',
    description: 'Get paginated physiological cycles with strain and heart rate metrics',
    inputSchema: { type: 'object', properties: paginationProps, required: [] },
  },
  {
    name: 'whoop_get_cycle_by_id',
    description: 'Get one physiological cycle by ID',
    inputSchema: {
      type: 'object',
      properties: { cycleId: { type: 'number', description: 'Cycle ID' } },
      required: ['cycleId'],
    },
  },
  {
    name: 'whoop_get_sleep_for_cycle',
    description: 'Get sleep data for a specific cycle',
    inputSchema: {
      type: 'object',
      properties: { cycleId: { type: 'number', description: 'Cycle ID' } },
      required: ['cycleId'],
    },
  },
  {
    name: 'whoop_get_recovery_collection',
    description: 'Get paginated recovery data (recovery score, HRV, RHR, SpO2, skin temp)',
    inputSchema: { type: 'object', properties: paginationProps, required: [] },
  },
  {
    name: 'whoop_get_recovery_for_cycle',
    description: 'Get recovery data for a specific cycle',
    inputSchema: {
      type: 'object',
      properties: { cycleId: { type: 'number', description: 'Cycle ID' } },
      required: ['cycleId'],
    },
  },
  {
    name: 'whoop_get_sleep_collection',
    description: 'Get paginated sleep records (stages, performance, respiratory rate)',
    inputSchema: { type: 'object', properties: paginationProps, required: [] },
  },
  {
    name: 'whoop_get_sleep_by_id',
    description: 'Get one sleep record by ID',
    inputSchema: {
      type: 'object',
      properties: { sleepId: { type: 'string', description: 'Sleep record UUID' } },
      required: ['sleepId'],
    },
  },
  {
    name: 'whoop_get_workout_collection',
    description: 'Get paginated workouts (strain, heart rate zones, distance, altitude)',
    inputSchema: { type: 'object', properties: paginationProps, required: [] },
  },
  {
    name: 'whoop_get_workout_by_id',
    description: 'Get one workout record by ID',
    inputSchema: {
      type: 'object',
      properties: { workoutId: { type: 'string', description: 'Workout UUID' } },
      required: ['workoutId'],
    },
  },
  {
    name: 'whoop_revoke_user_access',
    description: 'Revoke the current access token (logs the user out of this server)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export function buildMcpServer(client: WhoopApiClient): Server {
  const server = new Server(
    { name: 'whoop-mcp-server', version: '2.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;
    const pag = {
      limit: a.limit as number | undefined,
      start: a.start as string | undefined,
      end: a.end as string | undefined,
      nextToken: a.nextToken as string | undefined,
    };

    const asText = (v: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
    });

    try {
      switch (name) {
        case 'whoop_get_user_profile':
          return asText(await client.getUserProfile());
        case 'whoop_get_user_body_measurements':
          return asText(await client.getUserBodyMeasurements());
        case 'whoop_get_cycle_collection':
          return asText(await client.getCycleCollection(pag));
        case 'whoop_get_cycle_by_id':
          return asText(await client.getCycleById(a.cycleId as number));
        case 'whoop_get_sleep_for_cycle':
          return asText(await client.getSleepForCycle(a.cycleId as number));
        case 'whoop_get_recovery_collection':
          return asText(await client.getRecoveryCollection(pag));
        case 'whoop_get_recovery_for_cycle':
          return asText(await client.getRecoveryForCycle(a.cycleId as number));
        case 'whoop_get_sleep_collection':
          return asText(await client.getSleepCollection(pag));
        case 'whoop_get_sleep_by_id':
          return asText(await client.getSleepById(a.sleepId as string));
        case 'whoop_get_workout_collection':
          return asText(await client.getWorkoutCollection(pag));
        case 'whoop_get_workout_by_id':
          return asText(await client.getWorkoutById(a.workoutId as string));
        case 'whoop_revoke_user_access':
          await client.revokeUserAccess();
          return { content: [{ type: 'text' as const, text: 'Access revoked. Re-authenticate at /authorize.' }] };
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const status =
        typeof err === 'object' && err !== null && 'response' in err
          ? ((err as { response?: { status?: number } }).response?.status ?? '')
          : '';
      const hint = status === 401 || /unauthorized|token/i.test(msg)
        ? '\n\nHint: WHOOP token is missing or expired. Visit the /authorize endpoint of this server to re-authenticate.'
        : '';
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}${hint}` }],
        isError: true,
      };
    }
  });

  return server;
}
