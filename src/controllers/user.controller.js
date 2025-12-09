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
        name
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true
      }
    });

    // Initialize game statistics for new user
    await initializeUserGameStats(user.id);

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'User created successfully',
      user,
      token
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }};
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

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

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
  }};
export const getProfile = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        name: true,
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
  }};
export const updateProfile = async (req, res) => {
  try {
    const { name, battleBonus, levelReward, rating } = req.body;
    const userId = req.user.id;

    // Prepare data for update, only include fields if they are provided
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
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