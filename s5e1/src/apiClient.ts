import axios, { AxiosError } from 'axios';
import { ApiResponse, FinalReport, ListenResult, SessionStatus } from './types';
import { logger } from './logger';

const BASE_URL = process.env.CENTRAL_HUB!;
const API_KEY  = process.env.AI_DEVS_API_KEY!;
const TASK     = 'radiomonitoring';

async function post(answer: Record<string, unknown>): Promise<ApiResponse> {
  const payload = { apikey: API_KEY, task: TASK, answer };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post<ApiResponse>(BASE_URL, payload, { timeout: 30_000 });
      return res.data;
    } catch (err) {
      const e = err as AxiosError;
      const status = e.response?.status;
      // Don't retry on 4xx — these are definitive rejections, not transient failures
      if (status && status >= 400 && status < 500) throw err;
      logger.warn(`API call failed (attempt ${attempt}/3)`, {
        message: e.message,
        status,
      });
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error('Unreachable');
}

export const apiClient = {
  async start(): Promise<ApiResponse> {
    logger.info('Starting radio monitoring session');
    const res = await post({ action: 'start' });
    logger.info('Session started', { code: res.code, message: res.message });
    return res;
  },

  async listen(): Promise<ListenResult> {
    const res = await post({ action: 'listen' });
    // code 100 = "Signal captured" — session continues; any other code = end of data
    const status = res.code === 100 ? SessionStatus.CONTINUE : SessionStatus.END_OF_DATA;
    logger.debug('Listen response', { code: res.code, status, message: res.message });
    return { status, data: res };
  },

  async transmit(report: FinalReport): Promise<ApiResponse> {
    logger.info('Transmitting final report', report);
    try {
      const res = await post({ action: 'transmit', ...report });
      logger.info('Transmit response', { code: res.code, message: res.message });
      return res;
    } catch (err) {
      const e = err as AxiosError;
      // On 400 return the body so the orchestrator can inspect the error code (-740 etc.)
      if (e.response?.status === 400 && e.response.data) {
        const data = e.response.data as ApiResponse;
        logger.warn('Transmit rejected by hub', { code: data.code, message: data.message });
        return data;
      }
      throw err;
    }
  },
};
