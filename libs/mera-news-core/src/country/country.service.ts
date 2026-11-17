import { Injectable, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import {
  PublicationSource,
  PublicationSourceDocument,
} from '@mera/models/models/publication-source.model';

@Injectable()
export class CountryService {
  private readonly CACHE_KEY = 'all_countries';
  private readonly CACHE_TTL = 3600000; // 1 hour in milliseconds

  constructor(
    @InjectModel(PublicationSource.name)
    private publicationSourceModel: Model<PublicationSourceDocument>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async findAllCountries(): Promise<string[]> {
    const cached = await this.cacheManager.get<string[]>(this.CACHE_KEY);
    if (cached) {
      return cached;
    }

    const countries = await this.publicationSourceModel
      .distinct('country_code')
      .exec();
    await this.cacheManager.set(this.CACHE_KEY, countries, this.CACHE_TTL);
    return countries;
  }

  async invalidateCache(): Promise<void> {
    await this.cacheManager.del(this.CACHE_KEY);
  }
}
