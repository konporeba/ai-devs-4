import { CityData, ExtractedInfo, FinalReport } from './types';
import { logger } from './logger';

const MIN_PHONE_DIGITS = 7;

export class InformationAggregator {
  private data: ExtractedInfo = {};
  private cityList: CityData[] = [];
  private sourceCount = 0;

  merge(info: ExtractedInfo, source: string): void {
    const useful = Object.keys(info).filter(k => (info as Record<string, unknown>)[k] != null);
    if (useful.length === 0) return;

    this.sourceCount++;
    logger.debug(`Merging from ${source}`, info);

    // Accumulate city list from JSON sources
    if (info.cityList && info.cityList.length > 0) {
      this.cityList = info.cityList;
      logger.debug('City list stored', { count: this.cityList.length });
    }

    // cityName: first non-null wins
    if (info.cityName && !this.data.cityName)
      this.data.cityName = info.cityName;

    // cityArea: first non-null wins (from explicit sources)
    if (info.cityArea && !this.data.cityArea)
      this.data.cityArea = info.cityArea;

    // warehousesCount: first non-null wins
    if (info.warehousesCount != null && this.data.warehousesCount == null)
      this.data.warehousesCount = info.warehousesCount;

    // phoneNumber: only accept numbers with at least MIN_PHONE_DIGITS digits
    if (info.phoneNumber && !this.data.phoneNumber) {
      const digits = info.phoneNumber.replace(/\D/g, '');
      if (digits.length >= MIN_PHONE_DIGITS) {
        this.data.phoneNumber = digits;
      } else {
        logger.warn(`Rejected phone number — too short (${digits.length} digits)`, { phone: info.phoneNumber, source });
      }
    }

    // After each merge, try to resolve cityArea from city list if we have cityName
    this.resolveFromList();

    logger.info('Aggregator state after merge', { data: this.data, sources: this.sourceCount });
  }

  private resolveFromList(): void {
    if (!this.data.cityName) return;
    if (this.cityList.length === 0) return;

    const needle = this.data.cityName.toLowerCase().trim();
    const match = this.cityList.find(c => c.name.toLowerCase().trim() === needle);
    if (!match) {
      logger.debug(`City "${this.data.cityName}" not found in city list (${this.cityList.length} entries)`);
      return;
    }

    if (!this.data.cityArea) {
      logger.info(`Area resolved from city list for "${this.data.cityName}"`, { area: match.area });
      this.data.cityArea = match.area;
    }
    if (this.data.warehousesCount == null && match.warehouses != null) {
      logger.info(`warehousesCount resolved from city list for "${this.data.cityName}"`, { warehouses: match.warehouses });
      this.data.warehousesCount = match.warehouses;
    }
    if (!this.data.phoneNumber && match.phone) {
      logger.info(`phoneNumber resolved from city list for "${this.data.cityName}"`, { phone: match.phone });
      this.data.phoneNumber = match.phone;
    }
  }

  isComplete(): boolean {
    return !!(
      this.data.cityName &&
      this.data.cityArea &&
      this.data.warehousesCount != null &&
      this.data.phoneNumber
    );
  }

  /** Overwrite specific fields regardless of existing values (for synthesis corrections). */
  forceSet(info: Partial<ExtractedInfo>, source: string): void {
    logger.info(`forceSet from ${source}`, info);
    if (info.warehousesCount != null) this.data.warehousesCount = info.warehousesCount;
    if (info.cityName)    this.data.cityName    = info.cityName;
    if (info.cityArea)    this.data.cityArea    = info.cityArea;
    if (info.phoneNumber) this.data.phoneNumber = info.phoneNumber;
  }

  getState(): ExtractedInfo {
    return { ...this.data };
  }

  buildReport(): FinalReport {
    if (!this.isComplete()) {
      throw new Error(`Cannot build report — missing fields: ${JSON.stringify(this.data)}`);
    }

    // Ensure cityArea has exactly 2 decimal places (mathematical rounding, not truncation)
    const area = parseFloat(this.data.cityArea!);
    if (isNaN(area)) {
      throw new Error(`Invalid cityArea value: "${this.data.cityArea}"`);
    }

    return {
      cityName:        this.data.cityName!,
      cityArea:        area.toFixed(2),
      warehousesCount: this.data.warehousesCount!,
      phoneNumber:     this.data.phoneNumber!,
    };
  }
}
