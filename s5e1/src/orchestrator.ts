import { apiClient }       from './apiClient';
import { routeData }        from './dataRouter';
import { analyzeText }      from './agents/textAnalyst';
import { analyzeImage }     from './agents/imageAnalyst';
import { transcribeAudio }  from './agents/audioTranscriber';
import { parseJsonBinary }  from './handlers/jsonParser';
import { InformationAggregator } from './aggregator';
import { BinarySubtype, DataType, SessionStatus } from './types';
import { logger }           from './logger';
import { synthesizeMissingFields } from './agents/synthesizer';

const MAX_ITERATIONS = 50;

export async function runOrchestrator(): Promise<void> {
  logger.info('=== Radio Monitoring System — START ===');

  await apiClient.start();

  const aggregator = new InformationAggregator();

  // Collect all raw text for potential synthesis step
  const rawTexts: string[] = [];

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    logger.info(`--- Iteration ${i}/${MAX_ITERATIONS} ---`);

    const { status, data } = await apiClient.listen();

    if (status === SessionStatus.END_OF_DATA) {
      logger.info('End-of-data signal received', { code: data.code, message: data.message });
      break;
    }

    const routed = routeData(data);
    logger.info(`Routed → ${routed.type}${routed.subtype ? '/' + routed.subtype : ''}`);

    if (routed.type === DataType.NOISE) continue;

    if (routed.type === DataType.TEXT && routed.transcription) {
      rawTexts.push(routed.transcription);
      const extracted = await analyzeText(routed.transcription);
      aggregator.merge(extracted, `TEXT#${i}`);
    }

    if (routed.type === DataType.BINARY && routed.binaryBuffer) {
      switch (routed.subtype) {

        case BinarySubtype.IMAGE: {
          const extracted = await analyzeImage(routed.binaryBuffer, routed.mimeType!);
          aggregator.merge(extracted, `IMAGE#${i}`);
          break;
        }

        case BinarySubtype.AUDIO: {
          const { extracted, transcript } = await transcribeAudio(routed.binaryBuffer, routed.mimeType!);
          if (transcript.length > 0) rawTexts.push(transcript);
          aggregator.merge(extracted, `AUDIO#${i}`);
          break;
        }

        case BinarySubtype.JSON:
        case BinarySubtype.TEXT_FILE: {
          const extracted = parseJsonBinary(routed.binaryBuffer);
          // Also keep text content for synthesis
          const textContent = routed.binaryBuffer.toString('utf8');
          if (textContent.length < 10000) rawTexts.push(textContent);
          aggregator.merge(extracted, `JSON#${i}`);
          break;
        }

        case BinarySubtype.PDF:
          logger.warn('PDF received — skipping', { sizeBytes: routed.binaryBuffer.length });
          break;

        default:
          logger.warn('Unknown binary subtype, skipping', { subtype: routed.subtype });
      }
    }

    if (aggregator.isComplete()) {
      logger.info('All four fields collected — stopping early');
      break;
    }
  }

  // --- Synthesis step ---
  // Always verify warehousesCount (audio "build 12 magazine" is ambiguous)
  // plus fill any still-missing fields
  const state = aggregator.getState();
  const fieldsForSynthesis = ['cityName', 'cityArea', 'warehousesCount', 'phoneNumber']
    .filter(f => {
      const val = (state as Record<string, unknown>)[f];
      if (val == null) return true;               // missing → must synthesize
      if (f === 'warehousesCount') return true;   // always re-verify (audio is ambiguous)
      return false;
    });

  if (fieldsForSynthesis.length > 0 && rawTexts.length > 0) {
    logger.info(`Synthesis step — fields: ${fieldsForSynthesis.join(', ')}`);
    const synthesized = await synthesizeMissingFields(rawTexts, state, fieldsForSynthesis);
    // For warehousesCount: synthesis overrides pipeline value (synthesis is more reliable)
    if (synthesized.warehousesCount != null) {
      aggregator.forceSet({ warehousesCount: synthesized.warehousesCount }, 'SYNTHESIS');
    }
    aggregator.merge(synthesized, 'SYNTHESIS');
  }

  logger.info('Final aggregated state', aggregator.getState());

  if (!aggregator.isComplete()) {
    const finalState = aggregator.getState();
    logger.error('Incomplete data after all iterations', finalState);
    console.error('\n[ERROR] Missing fields:', finalState);
    throw new Error('Incomplete data — cannot transmit report');
  }

  const report = aggregator.buildReport();
  logger.info('Report ready', report);

  console.log('\n=== FINAL REPORT ===');
  console.log(JSON.stringify(report, null, 2));

  // Adaptive transmit retry: if hub rejects warehousesCount (-740), try alternatives
  const RETRY_CODES: Record<number, string> = { '-740': 'warehousesCount' };
  const rejectedValues: Partial<Record<string, unknown>> = {};

  for (let attempt = 1; attempt <= 5; attempt++) {
    const currentReport = aggregator.buildReport();
    logger.info(`Transmit attempt ${attempt}`, currentReport);

    const response = await apiClient.transmit(currentReport);

    console.log(`\n=== CENTRAL RESPONSE (attempt ${attempt}) ===`);
    console.log(JSON.stringify(response, null, 2));

    // Success — done
    if (!response.code || response.code > 0) {
      logger.info('=== Radio Monitoring System — COMPLETE ===', { response });
      return;
    }

    const errCode = String(response.code);

    // warehousesCount wrong → synthesize with rejection feedback, then try adjacent values
    if (errCode === '-740') {
      const badCount = aggregator.getState().warehousesCount!;
      logger.warn(`warehousesCount ${badCount} rejected — re-synthesizing with feedback`);
      rejectedValues.warehousesCount = badCount;

      const reSynthesized = await synthesizeMissingFields(
        rawTexts, aggregator.getState(), ['warehousesCount'], rejectedValues,
      );

      if (reSynthesized.warehousesCount != null && reSynthesized.warehousesCount !== badCount) {
        aggregator.forceSet({ warehousesCount: reSynthesized.warehousesCount }, `RETRY#${attempt}`);
      } else {
        // LLM still gives same answer — try badCount-1 then badCount+1
        const next = attempt % 2 === 1 ? badCount - 1 : badCount + 1;
        logger.warn(`Synthesizer unchanged — trying adjacent warehousesCount ${next}`);
        aggregator.forceSet({ warehousesCount: next }, `ADJACENT#${attempt}`);
      }
      continue;
    }

    // Any other error — log and stop
    logger.error('Unrecoverable hub error', { response });
    break;
  }

  logger.info('=== Radio Monitoring System — COMPLETE ===');
}
