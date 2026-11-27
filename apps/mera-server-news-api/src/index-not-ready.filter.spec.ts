import { Logger } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { IndexNotReadyFilter } from './index-not-ready.filter';

describe('IndexNotReadyFilter', () => {
  const error = (code: string) =>
    new GraphQLError('boom', { extensions: { code } });

  afterEach(() => jest.restoreAllMocks());

  it.each(['INDEX_NOT_READY', 'EDITION_CHANGED'])(
    'logs %s without an ERROR line or stack',
    (code) => {
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const lower = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const info = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const e = error(code);
      expect(new IndexNotReadyFilter().catch(e)).toBe(e);
      expect(err).not.toHaveBeenCalled();
      expect(lower.mock.calls.length + info.mock.calls.length).toBe(1);
    },
  );

  it('still logs other errors at ERROR', () => {
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    new IndexNotReadyFilter().catch(error('SOMETHING_ELSE'));
    expect(err).toHaveBeenCalledTimes(1);
  });
});
