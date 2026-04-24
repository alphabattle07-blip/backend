import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma.js';

// Default games configuration
const DEFAULT_GAMES = [
  { id: 'chess', title: 'Chess' },
  { id: 'ayo', title: 'Ayo' },
  { id: 'whot', title: 'Whot' },
  { id: 'ludo', title: 'Ludo' },
  { id: 'draughts', title: 'Draughts' },
];

// Initialize default game statistics for a new user
const initializeUserGameStats = async (userId) => {
  try {
    const gameStatsData = DEFAULT_GAMES.map(game => ({
      userId,
      gameId: game.id,
      wins: 0,
      losses: 0,
      draws: 0,
      rating: 1000, // Rookie level
    }));

    await prisma.gameStats.createMany({
      data: gameStatsData,
      skipDuplicates: true,
    });
  } catch (error) {
    console.error('Error initializing user game stats:', error);
  }
};

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const SALT_ROUNDS = 12;
const MAX_GUESTS_PER_DEVICE = 3; // Anti-abuse: max guest accounts per device per 30 days

// Shared JWT generator — 30 days for all users (registered refresh silently)
const generateToken = (user) => {
  return jwt.sign(
    { userId: user.id, name: user.name || 'Player', accountType: user.accountType || 'registered' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
};

export const register = async (req, res) => {
  try {
    const { email, password, name } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        accountType: 'registered',
        provider: 'email',
        battleBonus: 1000, // Initial welcome bonus matching Welcome UI
        rating: 1000      // Starting global rating
      },
      select: {
        id: true,
        email: true,
        name: true,
        accountType: true,
        createdAt: true
      }
    });

    // Initialize game statistics for new user
    await initializeUserGameStats(user.id);

    const token = generateToken(user);

    res.status(201).json({
      message: 'User created successfully',
      user,
      token
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user);

    // Return user data without password
    const { password: _, ...userWithoutPassword } = user;

    res.json({
      message: 'Login successful',
      user: userWithoutPassword,
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
// ═══════════════════════════════════════════════════
// GUEST LOGIN — Silent auto-create, no UI friction
// ═══════════════════════════════════════════════════
export const guestLogin = async (req, res) => {
  try {
    const { guestId, deviceId } = req.body;

    if (!guestId) {
      return res.status(400).json({ error: 'guestId is required' });
    }

    // 1. Check if this guest already exists → return existing session
    const existingGuest = await prisma.user.findUnique({
      where: { guestId },
      select: {
        id: true, email: true, name: true, avatar: true,
        accountType: true, guestId: true, rating: true,
        battleBonus: true, levelReward: true, createdAt: true,
        gameStats: { select: { gameId: true, wins: true, losses: true, draws: true, rating: true } }
      }
    });

    if (existingGuest) {
      const token = generateToken(existingGuest);
      return res.json({ message: 'Guest session restored', user: existingGuest, token });
    }

    // 2. Anti-abuse: Check device guest limit (3 per device per 30 days)
    if (deviceId && deviceId !== 'unknown') {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentGuestsFromDevice = await prisma.user.count({
        where: {
          deviceId,
          accountType: 'guest',
          createdAt: { gte: thirtyDaysAgo }
        }
      });

      if (recentGuestsFromDevice >= MAX_GUESTS_PER_DEVICE) {
        return res.status(429).json({
          error: 'Too many guest accounts from this device. Please sign in.'
        });
      }
    }

    // 3. Generate display name: Guest + random 3-digit
    const displayName = `Guest${Math.floor(100 + Math.random() * 900)}`;

    // 4. Create guest user
    const user = await prisma.user.create({
      data: {
        guestId,
        deviceId: deviceId || null,
        name: displayName,
        accountType: 'guest',
        battleBonus: 500, // Smaller welcome bonus for guests
        rating: 1000
      },
      select: {
        id: true, email: true, name: true, avatar: true,
        accountType: true, guestId: true, rating: true,
        battleBonus: true, levelReward: true, createdAt: true
      }
    });

    // 5. Initialize game stats
    await initializeUserGameStats(user.id);

    const token = generateToken(user);

    res.status(201).json({
      message: 'Guest account created',
      user,
      token
    });

  } catch (error) {
    console.error('Guest login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ═══════════════════════════════════════════════════
// UPGRADE ACCOUNT — Merge guest → registered (preserves all progress)
// ═══════════════════════════════════════════════════
export const upgradeAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const { email, password, name, provider } = req.body;

    // 1. Find the current user
    const currentUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 2. Must be a guest to upgrade
    if (currentUser.accountType !== 'guest') {
      return res.status(400).json({ error: 'Account is already registered' });
    }

    // 3. Validate: email required for upgrade
    if (!email) {
      return res.status(400).json({ error: 'Email is required for account upgrade' });
    }

    // 4. Check email isn't already taken by another user
    const emailConflict = await prisma.user.findUnique({ where: { email } });
    if (emailConflict && emailConflict.id !== userId) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // 5. Build update data (atomic merge)
    const updateData = {
      email,
      accountType: 'registered',
      provider: provider || 'email',
      // guestId is preserved for audit trail, not cleared
    };

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      updateData.password = await bcrypt.hash(password, SALT_ROUNDS);
    }

    if (name) {
      updateData.name = name.trim();
    }

    // 6. Perform the upgrade (rating, coins, match history all preserved automatically)
    const upgradedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true, email: true, name: true, avatar: true,
        accountType: true, rating: true, battleBonus: true,
        levelReward: true, createdAt: true, updatedAt: true,
        gameStats: { select: { gameId: true, wins: true, losses: true, draws: true, rating: true } }
      }
    });

    // 7. Issue fresh token with registered accountType
    const token = generateToken(upgradedUser);

    console.log(`[Auth] Guest ${currentUser.guestId} upgraded to registered: ${email}`);

    res.json({
      message: 'Account upgraded successfully! Your rank and rewards are preserved.',
      user: upgradedUser,
      token
    });

  } catch (error) {
    console.error('Upgrade account error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getProfile = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        accountType: true,
        guestId: true,
        battleBonus: true,
        levelReward: true,
        rating: true,
        createdAt: true,
        updatedAt: true,
        gameStats: {
          select: {
            gameId: true,
            wins: true,
            losses: true,
            draws: true,
            rating: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
export const updateProfile = async (req, res) => {
  try {
    const { name, avatar, battleBonus, levelReward, rating } = req.body;
    const userId = req.user.id;

    // Prepare data for update, only include fields if they are provided
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (avatar !== undefined) updateData.avatar = avatar;
    if (battleBonus !== undefined) updateData.battleBonus = battleBonus;
    if (levelReward !== undefined) updateData.levelReward = levelReward;
    if (rating !== undefined) updateData.rating = rating;

    // Validate input - ensure at least one field is provided for update
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No profile fields provided for update' });
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        battleBonus: true,
        levelReward: true,
        rating: true,
        updatedAt: true
      }
    });

    res.json({
      message: 'Profile updated successfully',
      user: updatedUser
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update game statistics for a specific game
export const updateGameStats = async (req, res) => {
  try {
    const { gameId } = req.params;
    const { wins, losses, draws, rating } = req.body;
    const userId = req.user.id;

    // Update or create game statistics
    const gameStats = await prisma.gameStats.upsert({
      where: {
        userId_gameId: {
          userId,
          gameId
        }
      },
      update: {
        wins: wins || undefined,
        losses: losses || undefined,
        draws: draws || undefined,
        rating: rating || undefined
      },
      create: {
        userId,
        gameId,
        wins: wins || 0,
        losses: losses || 0,
        draws: draws || 0,
        rating: rating || 1000
      }
    });

    res.json({
      message: 'Game statistics updated successfully',
      gameStats
    });
  } catch (error) {
    console.error('Update game stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get game statistics for a specific game
export const getGameStats = async (req, res) => {
  try {
    const { gameId } = req.params;
    const userId = req.user.id;

    // Find existing game stats
    const gameStats = await prisma.gameStats.findUnique({
      where: {
        userId_gameId: {
          userId,
          gameId
        }
      }
    });

    // If found, return existing stats
    if (gameStats) {
      return res.json({ gameStats });
    }

    // If not found, return default stats
    const defaultGame = DEFAULT_GAMES.find(game => game.id === gameId);
    if (!defaultGame) {
      return res.status(404).json({ error: 'Invalid game ID' });
    }

    const defaultStats = {
      gameId: defaultGame.id,
      title: defaultGame.title,
      wins: 0,
      losses: 0,
      draws: 0,
      rating: 1000,
      hasExistingStats: false
    };

    res.json({
      gameStats: defaultStats,
      message: 'Returning default game statistics (user has no existing stats)'
    });

  } catch (error) {
    console.error('Get game stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get all game statistics for a user with fallback to defaults
export const getAllGameStats = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all existing game stats for the user
    const existingStats = await prisma.gameStats.findMany({
      where: { userId }
    });

    // Create a map for easy lookup
    const statsMap = new Map();
    existingStats.forEach(stat => {
      statsMap.set(stat.gameId, stat);
    });

    // Merge with default games
    const allGameStats = DEFAULT_GAMES.map(game => {
      const existingStat = statsMap.get(game.id);
      return existingStat || {
        gameId: game.id,
        title: game.title,
        wins: 0,
        losses: 0,
        draws: 0,
        rating: 1000,
        hasExistingStats: false
      };
    });

    res.json({
      allGameStats,
      totalGames: allGameStats.length,
      gamesWithStats: existingStats.length
    });

  } catch (error) {
    console.error('Get all game stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};