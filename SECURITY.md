## Security: Secrets and Token Handling

This file documents recommended practices for handling secrets (API keys, private keys, tokens) used by this repository.

Immediate actions if a secret was exposed
- Revoke the leaked credential immediately (e.g., Docker Hub Access Token, cloud keys).
- Create a new credential with minimal scope and rotate any dependent systems.
- Audit recent activity (registry pushes, CI runs) for suspicious actions.

Safe secret management
- Never paste secrets or private keys into chat, issue trackers, or commit history.
- Store runtime secrets outside the repository using:
  - GitHub Actions Secrets for CI (`Settings → Secrets & variables → Actions`).
  - Cloud secret managers (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault) for production.
  - Environment files (`.env`) only for local development; never commit `.env` into git.

CI & Docker
- Use the repository `Secrets` to store tokens used by Actions (e.g., `DOCKERHUB_TOKEN`).
- In CI, avoid echoing secrets to logs. Use official actions that accept secrets via inputs.
- When logging into registries from CI, use stdin login:
  ```bash
  echo "$DOCKERHUB_TOKEN" | docker login --username "$DOCKERHUB_USERNAME" --password-stdin
  ```

Local usage
- Authenticate locally via `docker login --password-stdin` and avoid placing tokens in shell history.
- Use `gh secret set NAME --body "$(cat /path/to/secret)"` locally to upload secrets to GitHub without exposing them.

Encryption & persisted files
- `relayer-mappings.json` may contain mappings used by the relayer. Protect it:
  - Prefer running the relayer in a container with a mounted volume not checked into git.
  - Set `RELAYER_MAPPINGS_KEY` to enable on-disk AES-256-CBC encryption (the relayer supports this).
  - Keep file permissions restricted (the relayer will attempt `chmod 600`).

Rotation & least privilege
- Use short-lived credentials when possible and rotate tokens regularly (30–90 days depending on risk).
- Grant minimal privileges required for CI or runtime tasks (scoped tokens, limited write access).

Responding to leaks
1. Revoke the compromised credential immediately.
2. Rotate the credential and update secrets in CI and deployments.
3. Search repository history for accidental commits and remove sensitive files (use `git filter-repo` or `bfg`), then rotate again.
4. Check CI logs and registry activity for unauthorized actions; take remediation steps if needed.

Contact
- If you'd like, I can add automated scripts to rotate and update secrets in GitHub via the `gh` CLI, or add a short `SECURITY.md` link in the repo README. Tell me which you'd prefer.
# Security Policy

## 🔒 Security Features

FizzDex implements multiple layers of security to protect users and their assets:

### Smart Contract Security

1. **Reentrancy Protection**
   - All state-changing functions use reentrancy guards
   - Lock mechanisms prevent concurrent execution
   - Attack surface minimized through careful state management

2. **Overflow Protection**
   - All arithmetic uses checked math operations
   - Solidity 0.8+ native overflow protection
   - Additional validation in Solana program

3. **Access Control**
   - Owner-only functions for critical operations
   - Multi-sig recommended for production
   - Role-based permissions where appropriate

4. **Emergency Controls**
   - Pause mechanism for critical situations
   - Owner can pause trading if vulnerability detected
   - User funds remain safe during pause

5. **Input Validation**
   - All user inputs are validated
   - Address format checking per chain
   - Amount bounds checking
   - Slippage tolerance limits

### Operational Security

1. **Rate Limiting**
   - Game cooldowns prevent spam
   - Transaction rate limiting
   - DOS attack mitigation

2. **Slippage Protection**
   - User-defined maximum slippage
   - Dynamic slippage recommendations
   - Price impact warnings

3. **Gas Safety**
   - Gas estimation before transactions
   - Configurable gas limits
   - Protection against out-of-gas failures

## 🐛 Reporting Security Issues

We take security seriously. If you discover a security vulnerability, please:

### DO NOT

- ❌ Open a public GitHub issue
- ❌ Discuss publicly on Discord/Twitter
- ❌ Exploit the vulnerability

### DO

1. ✅ Email security@fizzdex.io with details
2. ✅ Include steps to reproduce
3. ✅ Provide your contact information
4. ✅ Allow reasonable time for fix

### Bug Bounty

We offer rewards for responsible disclosure:

- **Critical**: Up to $50,000
- **High**: Up to $10,000
- **Medium**: Up to $5,000
- **Low**: Up to $1,000

Severity determined by:
- Potential loss of funds
- Number of users affected
- Ease of exploitation
- Impact on protocol

## 🔐 Security Best Practices

### For Users

1. **Verify Addresses**
   ```typescript
   if (!SecurityUtils.validateAddress(address, chainType)) {
     throw new Error('Invalid address');
   }
   ```

2. **Set Appropriate Slippage**
   ```typescript
   const safeSlippage = SecurityUtils.calculateSafeSlippage(priceImpact);
   ```

3. **Check Transactions**
   ```typescript
   const validation = SecurityUtils.validateSwapParams({
     amount, minOutput, slippage
   });
   if (!validation.valid) {
     console.error(validation.error);
   }
   ```

4. **Start Small**
   - Test with small amounts first
   - Verify on testnets
   - Increase amounts gradually

5. **Monitor Approvals**
   - Review token approvals regularly
   - Revoke unnecessary approvals
   - Use hardware wallets for large amounts

### For Developers

1. **Never Bypass Security**
   - Use provided adapters
   - Don't skip validation
   - Follow security guidelines

2. **Handle Errors Properly**
   ```typescript
   try {
     await adapter.executeSwap(...);
   } catch (error) {
     // Log error
     // Alert user
     // Don't expose sensitive info
   }
   ```

3. **Sanitize Inputs**
   ```typescript
   const clean = SecurityUtils.sanitizeInput(userInput);
   ```

4. **Test Thoroughly**
   - Unit tests for all functions
   - Integration tests for flows
   - Security-specific test cases
   - Fuzz testing when possible

5. **Keep Dependencies Updated**
   ```bash
   npm audit
   npm update
   ```

## 🛡️ Audit Status

| Component | Status | Date | Auditor |
|-----------|--------|------|---------|
| EVM Contracts | Pending | - | TBD |
| Solana Program | Pending | - | TBD |
| TypeScript SDK | Internal | 2024-01 | Team |
| Bridge Contracts | Pending | - | TBD |

## 📋 Security Checklist

Before deployment:

- [ ] All contracts compiled without warnings
- [ ] Test coverage > 90%
- [ ] No high/critical vulnerabilities in dependencies
- [ ] Emergency pause tested
- [ ] Access control verified
- [ ] Rate limiting configured
- [ ] Slippage protection enabled
- [ ] Gas limits set appropriately
- [ ] Multi-sig wallet configured
- [ ] Monitoring alerts set up
- [ ] Bug bounty program active
- [ ] Security audit completed
- [ ] Insurance coverage obtained (if applicable)

## 🔍 Known Issues

No known security issues at this time.

## 📞 Contact

- **Security Email**: security@fizzdex.io
- **PGP Key**: [Link to PGP key]
- **Discord**: https://discord.gg/fizzdex (DM moderators)

## 🏆 Hall of Fame

We recognize and thank security researchers who help us:

*No reports yet - be the first!*

## 📚 Resources

- [Smart Contract Best Practices](https://consensys.github.io/smart-contract-best-practices/)
- [Solana Security Best Practices](https://docs.solana.com/developing/programming-model/security)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)

---

**Last Updated**: 2024-01-01

Thank you for helping keep FizzDex secure! 🙏
