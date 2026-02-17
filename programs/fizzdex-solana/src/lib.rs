use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer, Burn, burn},
};

declare_id!("FizzDEXProgram1111111111111111111111111111111");

// Constants for Fizz Caps Game
const FIZZ_REWARD: u64 = 10_000_000_000; // 10 tokens with 9 decimals
const BUZZ_REWARD: u64 = 15_000_000_000; // 15 tokens
const FIZZBUZZ_REWARD: u64 = 50_000_000_000; // 50 tokens
const PLAY_COOLDOWN: i64 = 60; // 60 seconds
const MAX_FEE_BPS: u16 = 500; // Max 5% fee for safety

#[program]
pub mod fizzdex_solana {
    use super::*;

    /// Initialize the DEX with security parameters
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeTooHigh);
        
        let dex_state = &mut ctx.accounts.dex_state;
        dex_state.authority = ctx.accounts.authority.key();
        dex_state.reward_mint = ctx.accounts.reward_mint.key();
        dex_state.fee_bps = fee_bps;
        dex_state.total_volume = 0;
        dex_state.total_players = 0;
        dex_state.paused = false;
        Ok(())
    }

    /// Create a liquidity pool with safety checks
    pub fn create_pool(ctx: Context<CreatePool>) -> Result<()> {
        let dex_state = &ctx.accounts.dex_state;
        require!(!dex_state.paused, ErrorCode::ContractPaused);
        
        let pool = &mut ctx.accounts.pool;
        pool.token_a_mint = ctx.accounts.token_a_mint.key();
        pool.token_b_mint = ctx.accounts.token_b_mint.key();
        pool.token_a_vault = ctx.accounts.token_a_vault.key();
        pool.token_b_vault = ctx.accounts.token_b_vault.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.reserve_a = 0;
        pool.reserve_b = 0;
        pool.total_lp_supply = 0;
        pool.locked = false;
        Ok(())
    }

    /// Add liquidity with reentrancy protection
    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a: u64,
        amount_b: u64,
        min_lp_amount: u64,
    ) -> Result<()> {
        let dex_state = &ctx.accounts.dex_state;
        require!(!dex_state.paused, ErrorCode::ContractPaused);
        
        let pool = &mut ctx.accounts.pool;
        require!(!pool.locked, ErrorCode::PoolLocked);
        require!(amount_a > 0 && amount_b > 0, ErrorCode::InvalidAmount);

        pool.locked = true;

        // Calculate LP tokens to mint
        let lp_amount = if pool.total_lp_supply == 0 {
            (amount_a as u128)
                .checked_mul(amount_b as u128)
                .ok_or(ErrorCode::Overflow)?
                .integer_sqrt() as u64
        } else {
            std::cmp::min(
                (amount_a as u128)
                    .checked_mul(pool.total_lp_supply as u128)
                    .ok_or(ErrorCode::Overflow)?
                    .checked_div(pool.reserve_a as u128)
                    .ok_or(ErrorCode::DivisionByZero)? as u64,
                (amount_b as u128)
                    .checked_mul(pool.total_lp_supply as u128)
                    .ok_or(ErrorCode::Overflow)?
                    .checked_div(pool.reserve_b as u128)
                    .ok_or(ErrorCode::DivisionByZero)? as u64,
            )
        };

        require!(lp_amount >= min_lp_amount, ErrorCode::SlippageExceeded);

        // Transfer tokens to pool vaults
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_a.to_account_info(),
                    to: ctx.accounts.token_a_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_a,
        )?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_b.to_account_info(),
                    to: ctx.accounts.token_b_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_b,
        )?;

        // Mint LP tokens
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.user_lp_token.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[&[
                    b"pool",
                    ctx.accounts.token_a_mint.key().as_ref(),
                    ctx.accounts.token_b_mint.key().as_ref(),
                    &[ctx.bumps.pool],
                ]],
            ),
            lp_amount,
        )?;

        pool.reserve_a = pool.reserve_a.checked_add(amount_a).ok_or(ErrorCode::Overflow)?;
        pool.reserve_b = pool.reserve_b.checked_add(amount_b).ok_or(ErrorCode::Overflow)?;
        pool.total_lp_supply = pool.total_lp_supply.checked_add(lp_amount).ok_or(ErrorCode::Overflow)?;
        pool.locked = false;

        Ok(())
    }

    /// Swap tokens with comprehensive safety checks
    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        min_amount_out: u64,
        a_to_b: bool,
    ) -> Result<()> {
        let dex_state = &mut ctx.accounts.dex_state;
        require!(!dex_state.paused, ErrorCode::ContractPaused);
        
        let pool = &mut ctx.accounts.pool;
        require!(!pool.locked, ErrorCode::PoolLocked);
        require!(amount_in > 0, ErrorCode::InvalidAmount);

        pool.locked = true;

        // Calculate output amount with fee
        let (reserve_in, reserve_out) = if a_to_b {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        let fee_multiplier = 10000u128.checked_sub(dex_state.fee_bps as u128).ok_or(ErrorCode::Overflow)?;
        let amount_in_with_fee = (amount_in as u128)
            .checked_mul(fee_multiplier)
            .ok_or(ErrorCode::Overflow)?;
        
        let numerator = amount_in_with_fee
            .checked_mul(reserve_out as u128)
            .ok_or(ErrorCode::Overflow)?;
        
        let denominator = (reserve_in as u128)
            .checked_mul(10000)
            .ok_or(ErrorCode::Overflow)?
            .checked_add(amount_in_with_fee)
            .ok_or(ErrorCode::Overflow)?;

        let amount_out = numerator.checked_div(denominator).ok_or(ErrorCode::DivisionByZero)? as u64;

        require!(amount_out >= min_amount_out, ErrorCode::SlippageExceeded);
        require!(amount_out < reserve_out, ErrorCode::InsufficientLiquidity);

        // Execute swap
        if a_to_b {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_in.to_account_info(),
                        to: ctx.accounts.vault_in.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_out.to_account_info(),
                        to: ctx.accounts.user_token_out.to_account_info(),
                        authority: pool.to_account_info(),
                    },
                    &[&[
                        b"pool",
                        ctx.accounts.token_a_mint.key().as_ref(),
                        ctx.accounts.token_b_mint.key().as_ref(),
                        &[ctx.bumps.pool],
                    ]],
                ),
                amount_out,
            )?;

            pool.reserve_a = pool.reserve_a.checked_add(amount_in).ok_or(ErrorCode::Overflow)?;
            pool.reserve_b = pool.reserve_b.checked_sub(amount_out).ok_or(ErrorCode::Underflow)?;
        } else {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_in.to_account_info(),
                        to: ctx.accounts.vault_in.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_out.to_account_info(),
                        to: ctx.accounts.user_token_out.to_account_info(),
                        authority: pool.to_account_info(),
                    },
                    &[&[
                        b"pool",
                        ctx.accounts.token_a_mint.key().as_ref(),
                        ctx.accounts.token_b_mint.key().as_ref(),
                        &[ctx.bumps.pool],
                    ]],
                ),
                amount_out,
            )?;

            pool.reserve_b = pool.reserve_b.checked_add(amount_in).ok_or(ErrorCode::Overflow)?;
            pool.reserve_a = pool.reserve_a.checked_sub(amount_out).ok_or(ErrorCode::Underflow)?;
        }

        dex_state.total_volume = dex_state.total_volume.checked_add(amount_in as u128).ok_or(ErrorCode::Overflow)?;
        pool.locked = false;

        Ok(())
    }

    /// Play Fizz Caps game with safety checks
    pub fn play_fizz_caps(ctx: Context<PlayFizzCaps>, number: u8) -> Result<()> {
        require!(number > 0 && number <= 100, ErrorCode::InvalidNumber);

        let player = &mut ctx.accounts.player_state;
        let clock = Clock::get()?;

        require!(
            clock.unix_timestamp >= player.last_play_time.checked_add(PLAY_COOLDOWN).ok_or(ErrorCode::Overflow)?,
            ErrorCode::CooldownActive
        );

        player.last_play_time = clock.unix_timestamp;
        player.total_plays = player.total_plays.checked_add(1).ok_or(ErrorCode::Overflow)?;

        let reward = if number % 15 == 0 {
            player.fizzbuzz_count = player.fizzbuzz_count.checked_add(1).ok_or(ErrorCode::Overflow)?;
            FIZZBUZZ_REWARD
        } else if number % 3 == 0 {
            player.fizz_count = player.fizz_count.checked_add(1).ok_or(ErrorCode::Overflow)?;
            FIZZ_REWARD
        } else if number % 5 == 0 {
            player.buzz_count = player.buzz_count.checked_add(1).ok_or(ErrorCode::Overflow)?;
            BUZZ_REWARD
        } else {
            0
        };

        if reward > 0 {
            player.pending_rewards = player.pending_rewards.checked_add(reward).ok_or(ErrorCode::Overflow)?;
        }

        Ok(())
    }

    /// Claim rewards with safety checks
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        let player = &mut ctx.accounts.player_state;
        let amount = player.pending_rewards;

        require!(amount > 0, ErrorCode::NoRewards);

        player.pending_rewards = 0;
        player.total_claimed = player.total_claimed.checked_add(amount).ok_or(ErrorCode::Overflow)?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reward_vault.to_account_info(),
                    to: ctx.accounts.user_reward_token.to_account_info(),
                    authority: ctx.accounts.dex_state.to_account_info(),
                },
                &[&[b"dex_state", &[ctx.bumps.dex_state]]],
            ),
            amount,
        )?;

        Ok(())
    }

    /// Emergency pause function for security
    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        let dex_state = &mut ctx.accounts.dex_state;
        require!(ctx.accounts.authority.key() == dex_state.authority, ErrorCode::Unauthorized);
        dex_state.paused = paused;
        Ok(())
    }

    // -------------------------
    // Atomic (HTLC) swap support
    // -------------------------

    /// Initiate an HTLC-style atomic swap on Solana — locks tokens in an escrow vault
    pub fn initiate_atomic_swap(
        ctx: Context<InitiateAtomicSwap>,
        amount: u64,
        secret_hash: [u8; 32],
        timelock: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(timelock > clock.unix_timestamp, ErrorCode::InvalidTimelock);
        require!(amount > 0, ErrorCode::InvalidAmount);

        let swap = &mut ctx.accounts.atomic_swap;
        swap.initiator = ctx.accounts.initiator.key();
        swap.participant = ctx.accounts.participant.key();
        swap.token_mint = ctx.accounts.token_mint.key();
        swap.escrow_vault = ctx.accounts.escrow_vault.key();
        swap.amount = amount;
        swap.secret_hash = secret_hash;
        swap.timelock = timelock;
        swap.completed = false;
        swap.refunded = false;

        // Transfer tokens from initiator to escrow vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.initiator_token_account.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.initiator.to_account_info(),
                },
            ),
            amount,
        )?;

        Ok(())
    }

    /// Complete an HTLC by providing the preimage (secret)
    pub fn complete_atomic_swap(ctx: Context<CompleteAtomicSwap>, secret: Vec<u8>) -> Result<()> {
        let swap = &mut ctx.accounts.atomic_swap;
        require!(!swap.completed, ErrorCode::AlreadyCompleted);
        require!(!swap.refunded, ErrorCode::AlreadyRefunded);

        // Verify secret hash (keccak256) — compatible with EVM keccak256(secret)
        let computed = solana_program::keccak::hash(&secret);
        require!(computed.0 == swap.secret_hash, ErrorCode::InvalidSecret);
        require!(ctx.accounts.participant.key() == swap.participant, ErrorCode::Unauthorized);

        // Transfer escrowed tokens to participant
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.participant_token_account.to_account_info(),
                    authority: ctx.accounts.atomic_swap.to_account_info(),
                },
                &[&[
                    b"atomic_swap",
                    swap.initiator.as_ref(),
                    swap.participant.as_ref(),
                    swap.token_mint.as_ref(),
                    &swap.timelock.to_le_bytes(),
                    &[ctx.bumps.atomic_swap],
                ]],
            ),
            swap.amount,
        )?;

        swap.completed = true;
        Ok(())
    }

    /// Refund an HTLC after timelock expires
    pub fn refund_atomic_swap(ctx: Context<RefundAtomicSwap>) -> Result<()> {
        let swap = &mut ctx.accounts.atomic_swap;
        require!(ctx.accounts.initiator.key() == swap.initiator, ErrorCode::Unauthorized);
        require!(!swap.completed, ErrorCode::AlreadyCompleted);
        require!(!swap.refunded, ErrorCode::AlreadyRefunded);

        let clock = Clock::get()?;
        require!(clock.unix_timestamp > swap.timelock, ErrorCode::TimelockNotExpired);

        // Transfer escrowed tokens back to initiator
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.initiator_token_account.to_account_info(),
                    authority: ctx.accounts.atomic_swap.to_account_info(),
                },
                &[&[
                    b"atomic_swap",
                    swap.initiator.as_ref(),
                    swap.participant.as_ref(),
                    swap.token_mint.as_ref(),
                    &swap.timelock.to_le_bytes(),
                    &[ctx.bumps.atomic_swap],
                ]],
            ),
            swap.amount,
        )?;

        swap.refunded = true;
        Ok(())
    }}

// Account structures with proper initialization

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + DexState::INIT_SPACE,
        seeds = [b"dex_state"],
        bump
    )]
    pub dex_state: Account<'info, DexState>,
    pub reward_mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(seeds = [b"dex_state"], bump)]
    pub dex_state: Account<'info, DexState>,
    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        token::mint = token_a_mint,
        token::authority = pool,
    )]
    pub token_a_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        token::mint = token_b_mint,
        token::authority = pool,
    )]
    pub token_b_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        mint::decimals = 9,
        mint::authority = pool,
    )]
    pub lp_mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(
        mut,
        seeds = [b"pool", token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(seeds = [b"dex_state"], bump)]
    pub dex_state: Account<'info, DexState>,
    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,
    #[account(mut)]
    pub token_a_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub token_b_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub lp_mint: Account<'info, Mint>,
}

// -------------------------
// Atomic-swap (HTLC) account contexts
// -------------------------

#[derive(Accounts)]
#[instruction(amount: u64, secret_hash: [u8;32], timelock: i64)]
pub struct InitiateAtomicSwap<'info> {
    #[account(mut)]
    pub initiator: Signer<'info>,
    /// CHECK: participant pubkey only
    pub participant: UncheckedAccount<'info>,
    pub token_mint: Account<'info, Mint>,
    #[account(mut, constraint = initiator_token_account.owner == initiator.key())]
    pub initiator_token_account: Account<'info, TokenAccount>,
    /// Escrow vault owned by the atomic_swap PDA
    #[account(
        init,
        payer = initiator,
        token::mint = token_mint,
        token::authority = atomic_swap,
        // escrow_vault uses a distinct seed to avoid PDA/address collision with the atomic_swap account
        seeds = [b"escrow_vault", initiator.key().as_ref(), participant.key().as_ref(), token_mint.key().as_ref(), &timelock.to_le_bytes()],
        bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = initiator,
        space = 8 + AtomicSwap::INIT_SPACE,
        seeds = [b"atomic_swap", initiator.key().as_ref(), participant.key().as_ref(), token_mint.key().as_ref(), &timelock.to_le_bytes()],
        bump
    )]
    pub atomic_swap: Account<'info, AtomicSwap>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CompleteAtomicSwap<'info> {
    #[account(mut)]
    pub participant: Signer<'info>,
    #[account(
        mut,
        seeds = [b"atomic_swap", atomic_swap.initiator.as_ref(), atomic_swap.participant.as_ref(), atomic_swap.token_mint.as_ref(), &atomic_swap.timelock.to_le_bytes()],
        bump
    )]
    pub atomic_swap: Account<'info, AtomicSwap>,
    #[account(mut, constraint = escrow_vault.mint == atomic_swap.token_mint && escrow_vault.owner == atomic_swap.key())]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = participant_token_account.owner == participant.key() && participant_token_account.mint == atomic_swap.token_mint)]
    pub participant_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundAtomicSwap<'info> {
    #[account(mut)]
    pub initiator: Signer<'info>,
    #[account(
        mut,
        seeds = [b"atomic_swap", atomic_swap.initiator.as_ref(), atomic_swap.participant.as_ref(), atomic_swap.token_mint.as_ref(), &atomic_swap.timelock.to_le_bytes()],
        bump
    )]
    pub atomic_swap: Account<'info, AtomicSwap>,
    #[account(mut, constraint = escrow_vault.mint == atomic_swap.token_mint && escrow_vault.owner == atomic_swap.key())]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = initiator_token_account.owner == initiator.key() && initiator_token_account.mint == atomic_swap.token_mint)]
    pub initiator_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
    #[account(mut)]
    pub user_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_lp_token: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        mut,
        seeds = [b"pool", token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"dex_state"], bump)]
    pub dex_state: Account<'info, DexState>,
    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,
    #[account(mut)]
    pub vault_in: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_out: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_in: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_out: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PlayFizzCaps<'info> {
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerState::INIT_SPACE,
        seeds = [b"player", player.key().as_ref()],
        bump
    )]
    pub player_state: Account<'info, PlayerState>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(
        mut,
        seeds = [b"player", player.key().as_ref()],
        bump
    )]
    pub player_state: Account<'info, PlayerState>,
    #[account(seeds = [b"dex_state"], bump)]
    pub dex_state: Account<'info, DexState>,
    #[account(mut)]
    pub reward_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_reward_token: Account<'info, TokenAccount>,
    pub player: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    #[account(mut, seeds = [b"dex_state"], bump)]
    pub dex_state: Account<'info, DexState>,
    pub authority: Signer<'info>,
}

// State structures with proper space allocation

#[account]
#[derive(InitSpace)]
pub struct DexState {
    pub authority: Pubkey,
    pub reward_mint: Pubkey,
    pub fee_bps: u16,
    pub total_volume: u128,
    pub total_players: u64,
    pub paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub lp_mint: Pubkey,
    pub reserve_a: u64,
    pub reserve_b: u64,
    pub total_lp_supply: u64,
    pub locked: bool,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerState {
    pub total_plays: u64,
    pub fizz_count: u32,
    pub buzz_count: u32,
    pub fizzbuzz_count: u32,
    pub pending_rewards: u64,
    pub total_claimed: u64,
    pub last_play_time: i64,
}

#[account]
#[derive(InitSpace)]
pub struct AtomicSwap {
    pub initiator: Pubkey,
    pub participant: Pubkey,
    pub token_mint: Pubkey,
    pub escrow_vault: Pubkey,
    pub amount: u64,
    pub secret_hash: [u8; 32],
    pub timelock: i64,
    pub completed: bool,
    pub refunded: bool,
}

// Helper trait for integer square root
trait IntegerSquareRoot {
    fn integer_sqrt(&self) -> Self;
}

impl IntegerSquareRoot for u128 {
    fn integer_sqrt(&self) -> Self {
        if *self < 2 {
            return *self;
        }
        let mut x = *self;
        let mut y = (x + 1) / 2;
        while y < x {
            x = y;
            y = (x + self / x) / 2;
        }
        x
    }
}

// Comprehensive error codes for safety
#[error_code]
pub enum ErrorCode {
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Insufficient liquidity")]
    InsufficientLiquidity,
    #[msg("Invalid number (must be 1-100)")]
    InvalidNumber,
    #[msg("Cooldown is still active")]
    CooldownActive,
    #[msg("No rewards to claim")]
    NoRewards,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Arithmetic underflow")]
    Underflow,
    #[msg("Division by zero")]
    DivisionByZero,
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Pool is locked (reentrancy protection)")]
    PoolLocked,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Fee too high (max 5%)")]
    FeeTooHigh,
    #[msg("Invalid timelock")]
    InvalidTimelock,
    #[msg("Invalid secret/preimage")]
    InvalidSecret,
    #[msg("Swap already completed")]
    AlreadyCompleted,
    #[msg("Swap already refunded")]
    AlreadyRefunded,
    #[msg("Timelock has not yet expired")]
    TimelockNotExpired,
}
