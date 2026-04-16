const path = require('path')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const StyleLintPlugin = require('stylelint-webpack-plugin')
const ESLintPlugin = require('eslint-webpack-plugin')

const child_process = require('child_process')
function git(command) {
  return child_process.execSync(`git ${command}`, { encoding: 'utf8' }).trim();
}

// Sass-loader config shared by both the CSS-modules and plain-SCSS rules.
// `quietDeps` silences deprecations that originate inside node_modules
// (i.e. Bootstrap's own SCSS). `silenceDeprecations` suppresses three
// deprecation classes that fire against our own files: `import` (our
// @import-based entry points), `global-builtin` (map-merge in bootstrap.scss),
// and `legacy-js-api` (sass-loader 13.x still uses sass's legacy JS API).
// Revisit when Bootstrap upgrades to @use/@forward or when Dart Sass 3.0
// forces a migration — see the Sass modules migration guide.
const sassLoaderOptions = {
  implementation: require("sass"),
  sourceMap: true,
  sassOptions: {
    quietDeps: true,
    silenceDeprecations: ['import', 'global-builtin', 'legacy-js-api']
  }
}

module.exports = {
  target: "web",
  entry: path.resolve(__dirname, '../src/index.tsx'),
  module: {
    rules: [
      {
        test: /\.module\.s?css$/,
        use: [
          MiniCssExtractPlugin.loader,
          {
            loader: 'css-loader',
            options: {
              modules: {
                localIdentName: '[name]__[local]--[hash:base64:5]'
              },
              url: false,
              sourceMap: true
            }
          },
          {
            loader: 'sass-loader',
            options: sassLoaderOptions
          }
        ]
      },
      {
        test: /\.s?[ac]ss$/,
        exclude: /\.module\.s?css$/,
        use: [
          MiniCssExtractPlugin.loader,
          {
            loader: 'css-loader',
            options: {
              modules: false,
              url: false,
              sourceMap: true
            }
          },
          {
            loader: 'sass-loader',
            options: sassLoaderOptions
          }
        ]
      },
      {
        test: /\.(ts|tsx|js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              '@babel/preset-env',
              '@babel/preset-typescript',
              ['@babel/preset-react', { runtime: 'automatic' }]
            ]
          }
        }
      }
    ]
  },
  plugins: [
    new MiniCssExtractPlugin({
      filename: '../dist/style.css'
    }),
    new StyleLintPlugin({
      threads: true,
    }),
    new ESLintPlugin({
      configType: 'flat',
      extensions: ['ts', 'tsx'],
      formatter: 'stylish'
    }),
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, '../src/index.html'),
      filename: 'index.html',
      inject: true
    })
  ],
  output: {
    clean: true,
    filename: 'entry.js',
    path: path.resolve(__dirname, '../dist'),
    publicPath: '/dist/'
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
    alias: {
      '@': path.resolve(__dirname, '../src')
    }
  },
  // Fixes weird issue with watch script. See
  // https://github.com/webpack/webpack/issues/2297#issuecomment-289291324
  watchOptions: {
    poll: true
  }
}
