import { PrismaClient } from '../generated/prisma/index.js';
import { initializeGameData } from '../utils/gameUtils.js';

// Helper for Whot deck generation
const SUIT_CARDS = {
  circle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  triangle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  cross: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  square: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  star: [1, 2, 3, 4, 5, 7, 8],
};

const generateWhotDeck = (ruleVersion = "rule1") => {
  const deck = [];
  for (const suit in SUIT_CARDS) {
    SUIT_CARDS[suit].forEach((num) => {
      deck.push({
        id: `${suit}-${num}`,
        suit: suit,
        number: num,
        rank: `${suit}-${num}`,
      });
    });
  }
  const whotCount = ruleVersion === "rule1" ? 5 : 0;
  for (let i = 1; i <= whotCount; i++) {
    deck.push({
      id: `whot-${i}`,
      suit: "whot",
      number: 20,
      rank: `whot-${i}`,
    });
  }
  return deck;
};

const shuffleArray = (array) => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const prisma = new PrismaClient();

// Create a new game
export const createGame = async (req, res) => {
  try {
    const { gameType } = req.body;
    const userId = req.user.id; // From auth middleware

    const game = await prisma.game.create({
      data: {
        gameType,
        player1Id: userId,
        status: 'WAITING'
      },
      include: {
        player1: {
          select: { id: true, name: true, rating: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      game
    });
  } catch (error) {
    console.error('Create game error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create game'
    });
  }
};

// Join an existing game
export const joinGame = async (req, res) => {
  try {
    const { gameId } = req.params;
    const userId = req.user.id;

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        player1: { select: { id: true, name: true, rating: true } },
        player2: { select: { id: true, name: true, rating: true } }
      }
    });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    if (game.status !== 'WAITING') {
      return res.status(400).json({
        success: false,
        message: 'Game is not available to join'
      });
    }

    if (game.player1Id === userId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot join your own game'
      });
    }

    // Update game with player 2
    const updateData = {
      player2Id: userId,
      status: 'IN_PROGRESS',
      startedAt: new Date(),
    };

    // Initialize state
    const gameData = initializeGameData(game.gameType, game.player1, { id: userId, name: req.user.name || 'Opponent' });
    Object.assign(updateData, gameData);

    const updatedGame = await prisma.game.update({
      where: { id: gameId },
      data: updateData,
      include: {
        player1: { select: { id: true, name: true, rating: true } },
        player2: { select: { id: true, name: true, rating: true } }
      }
    });

    res.json({
      success: true,
      game: updatedGame
    });
  } catch (error) {
    console.error('Join game error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to join game'
    });
  }
};

// Get available games
export const getAvailableGames = async (req, res) => {
  try {
    const games = await prisma.game.findMany({
      where: {
        status: 'WAITING',
        player2Id: null
      },
      include: {
        player1: {
          select: { id: true, name: true, rating: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      games
    });
  } catch (error) {
    console.error('Get available games error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch games'
    });
  }
};

// Get game by ID
export const getGame = async (req, res) => {
  try {
    const { gameId } = req.params;

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        player1: { select: { id: true, name: true, rating: true } },
        player2: { select: { id: true, name: true, rating: true } }
      }
    });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    res.json({
      success: true,
      game
    });
  } catch (error) {
    console.error('Get game error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch game'
    });
  }
};

// Update game state
export const updateGameState = async (req, res) => {
  try {
    const { gameId } = req.params;
    const { board, currentTurn, winnerId, status } = req.body;
    const userId = req.user.id;

    const game = await prisma.game.findUnique({
      where: { id: gameId }
    });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    // Check if user is part of the game
    if (game.player1Id !== userId && game.player2Id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this game'
      });
    }

    const updateData = {};
    if (board !== undefined) updateData.board = board;
    if (currentTurn !== undefined) updateData.currentTurn = currentTurn;
    if (winnerId !== undefined) updateData.winnerId = winnerId;
    if (status !== undefined) updateData.status = status;

    if (status === 'COMPLETED') {
      updateData.endedAt = new Date();
    }

    const updatedGame = await prisma.game.update({
      where: { id: gameId },
      data: updateData,
      include: {
        player1: { select: { id: true, name: true, rating: true } },
        player2: { select: { id: true, name: true, rating: true } }
      }
    });

    res.json({
      success: true,
      game: updatedGame
    });
  } catch (error) {
    console.error('Update game state error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update game'
    });
  }
};
