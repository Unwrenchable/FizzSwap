import { expect } from "chai";
import fetch from "node-fetch";

import { executeRouteHandler } from '../relayer/src/handlers';

describe('Relayer executeRouteHandler', function () {
  it('throws for missing parameters', async function () {
    try {
      await executeRouteHandler({});
      throw new Error('expected error');
    } catch (err: any) {
      expect(err).to.have.property('status');
      expect(err.status).to.equal(400);
    }
  });

  it('throws 500 when RELAYER_PRIVATE_KEY not configured for EVM', async function () {
    delete process.env.RELAYER_PRIVATE_KEY;
    try {
      await executeRouteHandler({ chainId: 'local-evm', chainType: 'evm', inputToken: '0x0', outputToken: '0x0', amount: '1' });
      throw new Error('expected error');
    } catch (err: any) {
      expect(err).to.have.property('status');
      expect(err.status).to.equal(500);
    }
  });
});
