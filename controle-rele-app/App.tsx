import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { NavigationBar } from "expo-navigation-bar";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	Modal,
	useWindowDimensions,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
	onAuthStateChanged,
	signInWithEmailAndPassword,
	signOut,
	type User,
} from "firebase/auth";
import { onValue, push, ref, set } from "firebase/database";
import { auth, database } from "./firebase/config";

type RelayState = {
	enabled: boolean;
	expiresAt: number;
	lastCommandId: string;
	lastSeenAt?: number;
};

const COLORS = {
	background: "#08131E",
	surface: "#112432",
	surface2: "#152C3C",
	border: "#294251",
	white: "#F4F8FB",
	muted: "#95ACB9",
	accent: "#55E1C2",
	accentDark: "#052D2A",
	red: "#FF8F8F",
};

const HEARTBEAT_TIMEOUT_MS = 30000;
const DURATIONS = [0, 10, 20, 30, 40, 50, 60];

function formatTime(seconds: number) {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remaining = seconds % 60;
	const mm = String(minutes).padStart(2, "0");
	const ss = String(remaining).padStart(2, "0");

	return hours > 0
		? `${String(hours).padStart(2, "0")}:${mm}:${ss}`
		: `${mm}:${ss}`;
}

export default function App() {
	const [user, setUser] = useState<User | null>(null);
	const [authLoading, setAuthLoading] = useState(true);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");

	const [relay, setRelay] = useState<RelayState | null>(null);
	const [connected, setConnected] = useState(false);
	const [serverOffset, setServerOffset] = useState(0);
	const [offsetReady, setOffsetReady] = useState(false);
	const [now, setNow] = useState(Date.now());

	const [duration, setDuration] = useState("30");
	const [busy, setBusy] = useState(false);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [customOpen, setCustomOpen] = useState(false);
	const [customValue, setCustomValue] = useState("30");
	const { height } = useWindowDimensions();
	const compact = height < 780;
	const veryCompact = height < 670;

	// Android: oculta apenas a barra de navegação inferior.
	// A barra superior (hora e bateria) continua visível.
	useEffect(() => {
		if (Platform.OS === "android") {
			NavigationBar.setHidden(true);
		}
	}, []);

	useEffect(() => {
		return onAuthStateChanged(auth, (currentUser) => {
			setUser(currentUser);
			setAuthLoading(false);
		});
	}, []);

	useEffect(() => {
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, []);

	useEffect(() => {
		if (!user) {
			setRelay(null);
			setConnected(false);
			setOffsetReady(false);
			return;
		}

		const unsubscribeState = onValue(
			ref(database, "relay/state"),
			(snapshot) => setRelay(snapshot.val() as RelayState | null),
			(err) => setError(err.message),
		);
		const unsubscribeConnection = onValue(
			ref(database, ".info/connected"),
			(snapshot) => setConnected(snapshot.val() === true),
		);
		const unsubscribeOffset = onValue(
			ref(database, ".info/serverTimeOffset"),
			(snapshot) => {
				const value = snapshot.val();
				if (typeof value === "number") {
					setServerOffset(value);
					setOffsetReady(true);
				}
			},
		);

		return () => {
			unsubscribeState();
			unsubscribeConnection();
			unsubscribeOffset();
		};
	}, [user]);

	useEffect(() => {
		if (pendingId && relay?.lastCommandId === pendingId) {
			setPendingId(null);
		}
	}, [pendingId, relay?.lastCommandId]);

	useEffect(() => {
		if (!pendingId) return;
		const timeout = setTimeout(() => {
			setPendingId(null);
			setError("O dispositivo não confirmou o comando.");
		}, 20000);
		return () => clearTimeout(timeout);
	}, [pendingId]);

	const serverNow = now + serverOffset;
	const heartbeatAge =
		typeof relay?.lastSeenAt === "number"
			? serverNow - relay.lastSeenAt
			: Infinity;
	const online =
		connected &&
		offsetReady &&
		heartbeatAge >= -10000 &&
		heartbeatAge < HEARTBEAT_TIMEOUT_MS;

	const isOn = relay?.enabled === true;
	const hasTimer = isOn && (relay?.expiresAt ?? 0) > 0;
	const remainingSeconds = Math.max(
		0,
		Math.ceil(((relay?.expiresAt ?? 0) - serverNow) / 1000),
	);
	const canSend = online && !busy && !pendingId;
	const selectedMinutes = Number(duration.trim());
	const durationValid =
		/^\d+$/.test(duration.trim()) &&
		selectedMinutes >= 0 &&
		selectedMinutes <= 1440;

	async function login() {
		setError("");
		setBusy(true);
		try {
			await signInWithEmailAndPassword(auth, email.trim(), password);
		} catch {
			setError("Não foi possível entrar. Confira o e-mail e a senha.");
		} finally {
			setBusy(false);
		}
	}

	async function sendCommand(enabled: boolean) {
		if (!canSend) return;
		if (enabled && !durationValid) {
			setError("Informe um tempo entre 0 e 1440 minutos.");
			return;
		}

		const id = push(ref(database, "relay/command")).key;
		if (!id) {
			setError("Não foi possível gerar o comando.");
			return;
		}

		setBusy(true);
		setPendingId(id);
		setError("");
		try {
			await set(ref(database, "relay/command"), {
				id,
				enabled,
				durationMinutes: enabled ? selectedMinutes : 0,
				createdAt: Math.round(Date.now() + serverOffset),
			});
		} catch {
			setPendingId(null);
			setError("Falha ao enviar comando ao Firebase.");
		} finally {
			setBusy(false);
		}
	}

	function openCustomTime() {
		setCustomValue(duration);
		setCustomOpen(true);
	}

	function saveCustomTime() {
		if (!/^\d+$/.test(customValue.trim()) || Number(customValue) > 1440) {
			setError("Informe de 0 a 1440 minutos.");
			return;
		}
		setError("");
		setDuration(String(Number(customValue)));
		setCustomOpen(false);
	}

	if (authLoading) {
		return (
			<SafeAreaView style={styles.screen}>
				<StatusBar style="light" />
				<View style={styles.center}>
					<ActivityIndicator size="large" color={COLORS.accent} />
				</View>
			</SafeAreaView>
		);
	}

	if (!user) {
		return (
			<SafeAreaView style={styles.screen}>
				<StatusBar style="light" />
				<KeyboardAvoidingView
					style={styles.center}
					behavior={Platform.OS === "ios" ? "padding" : undefined}
				>
					<View style={styles.loginContainer}>
						<View style={styles.loginIcon}>
							<Ionicons
								name="flash-outline"
								size={33}
								color={COLORS.accent}
							/>
						</View>
						<Text style={styles.eyebrow}>BEM-VINDO</Text>
						<Text style={styles.loginTitle}>
							Sua tomada,{"\n"}sob controle.
						</Text>
						<Text style={styles.subtitle}>
							Entre para controlar seu dispositivo de qualquer
							lugar.
						</Text>

						<View style={styles.loginFields}>
							<TextInput
								style={styles.input}
								placeholder="E-mail"
								placeholderTextColor={COLORS.muted}
								autoCapitalize="none"
								autoCorrect={false}
								keyboardType="email-address"
								value={email}
								onChangeText={setEmail}
							/>
							<TextInput
								style={styles.input}
								placeholder="Senha"
								placeholderTextColor={COLORS.muted}
								secureTextEntry
								value={password}
								onChangeText={setPassword}
								onSubmitEditing={login}
							/>
						</View>

						<Pressable
							onPress={login}
							disabled={busy}
							style={({ pressed }) => [
								styles.loginButton,
								(busy || pressed) && styles.buttonDimmed,
							]}
						>
							{busy ? (
								<ActivityIndicator color={COLORS.accentDark} />
							) : (
								<>
									<Text style={styles.loginButtonText}>
										Entrar
									</Text>
									<Ionicons
										name="arrow-forward"
										size={19}
										color={COLORS.accentDark}
									/>
								</>
							)}
						</Pressable>
						{!!error && (
							<Text style={styles.errorText}>{error}</Text>
						)}
					</View>
				</KeyboardAvoidingView>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView style={styles.screen} edges={["top"]}>
			<StatusBar style="light" />
			<View
				style={[styles.dashboard, veryCompact && styles.dashboardTiny]}
			>
				<View style={styles.topBar}>
					<View>
						{!veryCompact && (
							<Text style={styles.eyebrow}>CASA CONECTADA</Text>
						)}
						<Text
							style={[
								styles.title,
								veryCompact && styles.titleTiny,
							]}
						>
							Minha tomada
						</Text>
					</View>
					<Pressable
						onPress={() => signOut(auth)}
						accessibilityRole="button"
						accessibilityLabel="Sair da conta"
						style={styles.iconButton}
					>
						<Ionicons
							name="log-out-outline"
							size={20}
							color={COLORS.muted}
						/>
					</Pressable>
				</View>

				<View style={styles.onlineRow}>
					<View
						style={[
							styles.dot,
							{
								backgroundColor: online
									? COLORS.accent
									: COLORS.red,
							},
						]}
					/>
					<Text
						style={[
							styles.presenceText,
							{ color: online ? COLORS.accent : COLORS.red },
						]}
					>
						{online ? "Dispositivo online" : "Dispositivo offline"}
					</Text>
					<View style={{ flex: 1 }} />
					<Ionicons
						name={online ? "wifi" : "cloud-offline-outline"}
						size={17}
						color={online ? COLORS.accent : COLORS.red}
					/>
				</View>

				<LinearGradient
					colors={
						isOn
							? ["#173E39", "#102A34", "#0E202D"]
							: ["#173544", "#112A39", "#0D1F2C"]
					}
					start={{ x: 0, y: 0 }}
					end={{ x: 1, y: 1 }}
					style={[
						styles.mainPanel,
						veryCompact && styles.mainPanelTiny,
					]}
				>
					<View style={styles.heroHeader}>
						<Text style={styles.heroEyebrow}>ESTADO DO RELÉ</Text>
						<Ionicons
							name="hardware-chip-outline"
							size={18}
							color={COLORS.muted}
						/>
					</View>

					<View
						style={[
							styles.heroBody,
							veryCompact && styles.heroBodyTiny,
						]}
					>
						<View
							style={[
								styles.powerOuter,
								compact && styles.powerOuterCompact,
								isOn && styles.powerOuterOn,
							]}
						>
							<View
								style={[
									styles.powerInner,
									compact && styles.powerInnerCompact,
									isOn && styles.powerInnerOn,
								]}
							>
								<Ionicons
									name="power"
									size={compact ? 43 : 52}
									color={
										isOn ? COLORS.accentDark : COLORS.muted
									}
								/>
							</View>
						</View>
						<Text
							style={[
								styles.heroState,
								veryCompact && styles.heroStateTiny,
							]}
						>
							{relay === null
								? "Aguardando"
								: isOn
									? "Ligado"
									: "Desligado"}
						</Text>
						<Text style={styles.heroSubtitle} numberOfLines={2}>
							{!online
								? "Último estado conhecido"
								: hasTimer
									? "Desligamento programado"
									: isOn
										? "Ligado sem limite"
										: "Pronto para ligar"}
						</Text>
						{hasTimer && (
							<View
								style={[
									styles.countdownBar,
									veryCompact && styles.countdownBarTiny,
								]}
							>
								<Ionicons
									name="time-outline"
									size={18}
									color={COLORS.accent}
								/>
								<Text
									style={[
										styles.countdownNumber,
										veryCompact &&
											styles.countdownNumberTiny,
									]}
								>
									{formatTime(remainingSeconds)}
								</Text>
								<Text style={styles.countdownCaption}>
									restantes
								</Text>
							</View>
						)}
					</View>

					<View
						style={[
							styles.timerSection,
							veryCompact && styles.timerSectionTiny,
						]}
					>
						<View style={styles.timerHeader}>
							<View style={styles.timerHeaderTitle}>
								<Ionicons
									name="timer-outline"
									size={19}
									color={COLORS.accent}
								/>
								<Text style={styles.sectionTitle}>
									Temporizador
								</Text>
							</View>
							<Text style={styles.sectionCaption}>
								em minutos
							</Text>
						</View>
						<View style={styles.chips}>
							{DURATIONS.map((minutes) => {
								const selected = duration === String(minutes);
								return (
									<Pressable
										key={minutes}
										accessibilityRole="button"
										accessibilityState={{ selected }}
										onPress={() =>
											setDuration(String(minutes))
										}
										style={[
											styles.chip,
											veryCompact && styles.chipTiny,
											selected && styles.chipSelected,
										]}
									>
										<Text
											style={[
												styles.chipText,
												selected &&
													styles.chipTextSelected,
											]}
										>
											{minutes === 0
												? "Sempre"
												: `${minutes} min`}
										</Text>
									</Pressable>
								);
							})}
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Definir tempo personalizado"
								onPress={openCustomTime}
								style={[
									styles.chip,
									veryCompact && styles.chipTiny,
									!DURATIONS.includes(Number(duration)) &&
										styles.chipSelected,
								]}
							>
								<Text
									style={[
										styles.chipText,
										!DURATIONS.includes(Number(duration)) &&
											styles.chipTextSelected,
									]}
									numberOfLines={1}
								>
									{!DURATIONS.includes(Number(duration))
										? `${duration} min`
										: "Outro…"}
								</Text>
							</Pressable>
						</View>
					</View>
				</LinearGradient>

				<View style={styles.actionDock}>
					<View style={styles.feedback}>
						{pendingId ? (
							<>
								<ActivityIndicator
									size="small"
									color={COLORS.accent}
								/>
								<Text
									style={styles.feedbackText}
									numberOfLines={2}
								>
									Aguardando confirmação do ESP8266...
								</Text>
							</>
						) : error ? (
							<>
								<Ionicons
									name="alert-circle-outline"
									size={16}
									color={COLORS.red}
								/>
								<Text
									style={[
										styles.feedbackText,
										{ color: COLORS.red },
									]}
									numberOfLines={2}
								>
									{error}
								</Text>
							</>
						) : (
							<>
								<Ionicons
									name="radio-outline"
									size={15}
									color={COLORS.muted}
								/>
								<Text
									style={styles.feedbackText}
									numberOfLines={1}
								>
									{Number.isFinite(heartbeatAge)
										? `Último sinal há ${Math.max(0, Math.floor(heartbeatAge / 1000))} s`
										: "Aguardando sinal do dispositivo"}
								</Text>
							</>
						)}
					</View>
					<View style={styles.actions}>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={
								isOn
									? "Atualizar tempo do relé"
									: "Ligar o relé"
							}
							disabled={!canSend}
							onPress={() => sendCommand(true)}
							style={({ pressed }) => [
								styles.onButton,
								(!canSend || pressed) && styles.buttonDimmed,
							]}
						>
							<Ionicons
								name="power"
								size={21}
								color={COLORS.accentDark}
							/>
							<Text style={styles.onButtonText}>
								{isOn ? "Atualizar" : "Ligar"}
							</Text>
						</Pressable>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Desligar o relé"
							disabled={!canSend}
							onPress={() => sendCommand(false)}
							style={({ pressed }) => [
								styles.offButton,
								(!canSend || pressed) && styles.buttonDimmed,
							]}
						>
							<Ionicons
								name="stop-circle-outline"
								size={21}
								color={COLORS.white}
							/>
							<Text style={styles.offButtonText}>Desligar</Text>
						</Pressable>
					</View>
				</View>
			</View>

			<Modal
				transparent
				animationType="fade"
				visible={customOpen}
				onRequestClose={() => setCustomOpen(false)}
			>
				<KeyboardAvoidingView
					style={styles.modalOverlay}
					behavior={Platform.OS === "ios" ? "padding" : undefined}
				>
					<Pressable
						style={StyleSheet.absoluteFill}
						onPress={() => setCustomOpen(false)}
					/>
					<View style={styles.modalCard}>
						<Text style={styles.modalTitle}>
							Tempo personalizado
						</Text>
						<Text style={styles.modalDescription}>
							Escolha de 0 a 1440 minutos. Zero significa sem
							limite.
						</Text>
						<TextInput
							autoFocus
							style={styles.modalInput}
							value={customValue}
							onChangeText={setCustomValue}
							keyboardType="number-pad"
							maxLength={4}
							selectTextOnFocus
							placeholder="Minutos"
							placeholderTextColor={COLORS.muted}
						/>
						<View style={styles.modalButtons}>
							<Pressable
								onPress={() => setCustomOpen(false)}
								style={styles.modalCancel}
							>
								<Text style={styles.modalCancelText}>
									Cancelar
								</Text>
							</Pressable>
							<Pressable
								onPress={saveCustomTime}
								style={styles.modalSave}
							>
								<Text style={styles.modalSaveText}>
									Confirmar
								</Text>
							</Pressable>
						</View>
					</View>
				</KeyboardAvoidingView>
			</Modal>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: COLORS.background },
	center: { flex: 1, justifyContent: "center", alignItems: "center" },
	dashboard: {
		flex: 1,
		paddingHorizontal: 18,
		paddingTop: 10,
		paddingBottom: 12,
		gap: 12,
	},
	// Um único painel flexível ocupa o espaço útil sem criar vazios entre cartões.
	mainPanel: {
		flex: 1,
		minHeight: 0,
		borderRadius: 22,
		borderWidth: 1,
		borderColor: COLORS.border,
		padding: 16,
		gap: 10,
		overflow: "hidden",
	},
	mainPanelTiny: { padding: 11, gap: 5 },
	heroBody: {
		flex: 1,
		minHeight: 0,
		alignItems: "center",
		justifyContent: "center",
		gap: 7,
	},
	heroBodyTiny: { gap: 3 },
	timerSection: {
		borderTopWidth: 1,
		borderTopColor: COLORS.border,
		paddingTop: 13,
		gap: 10,
	},
	timerSectionTiny: { paddingTop: 8, gap: 6 },
	topBar: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},
	eyebrow: {
		color: COLORS.accent,
		fontSize: 10,
		fontWeight: "800",
		letterSpacing: 1.8,
	},
	title: {
		color: COLORS.white,
		fontSize: 26,
		fontWeight: "800",
		marginTop: 2,
		letterSpacing: -0.7,
	},
	titleTiny: { fontSize: 23, marginTop: 0 },
	iconButton: {
		height: 38,
		width: 38,
		borderRadius: 13,
		backgroundColor: COLORS.surface,
		borderWidth: 1,
		borderColor: COLORS.border,
		alignItems: "center",
		justifyContent: "center",
	},
	onlineRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
		paddingVertical: 2,
	},
	dot: { width: 8, height: 8, borderRadius: 4 },
	presenceText: { fontSize: 12, fontWeight: "700" },

	heroHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},
	heroEyebrow: {
		color: COLORS.muted,
		fontSize: 10,
		fontWeight: "800",
		letterSpacing: 1.3,
	},
	powerOuter: {
		width: 126,
		height: 126,
		borderRadius: 63,
		borderWidth: 1,
		borderColor: "#355363",
		alignItems: "center",
		justifyContent: "center",
	},
	powerOuterCompact: { width: 108, height: 108, borderRadius: 54 },
	powerOuterOn: { borderColor: "#408C7A" },
	powerInner: {
		width: 100,
		height: 100,
		borderRadius: 50,
		backgroundColor: "#2B4957",
		alignItems: "center",
		justifyContent: "center",
	},
	powerInnerCompact: { width: 88, height: 88, borderRadius: 44 },
	powerInnerOn: { backgroundColor: COLORS.accent },
	heroState: {
		color: COLORS.white,
		fontSize: 35,
		fontWeight: "800",
		letterSpacing: -1,
	},
	heroStateTiny: { fontSize: 29 },
	heroSubtitle: {
		color: COLORS.muted,
		fontSize: 13,
		lineHeight: 18,
		textAlign: "center",
	},
	countdownBar: {
		backgroundColor: "#102B32",
		borderColor: "#356056",
		borderWidth: 1,
		paddingVertical: 8,
		paddingHorizontal: 15,
		borderRadius: 12,
		flexDirection: "row",
		alignItems: "center",
		gap: 9,
		marginTop: 3,
	},
	countdownBarTiny: { paddingVertical: 5 },
	countdownNumber: {
		color: COLORS.accent,
		fontWeight: "800",
		fontSize: 23,
		fontVariant: ["tabular-nums"],
	},
	countdownNumberTiny: { fontSize: 19 },
	countdownCaption: { color: COLORS.muted, fontSize: 12 },
	timerHeader: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
	},
	timerHeaderTitle: { flexDirection: "row", gap: 7, alignItems: "center" },
	sectionTitle: { color: COLORS.white, fontSize: 16, fontWeight: "800" },
	sectionCaption: { color: COLORS.muted, fontSize: 11 },
	chips: {
		flexDirection: "row",
		flexWrap: "wrap",
		justifyContent: "space-between",
		rowGap: 7,
	},
	chip: {
		width: "23%",
		paddingVertical: 10,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: "#2F4858",
		backgroundColor: COLORS.surface2,
		justifyContent: "center",
		alignItems: "center",
	},
	chipTiny: { paddingVertical: 7 },
	chipSelected: {
		backgroundColor: COLORS.accent,
		borderColor: COLORS.accent,
	},
	chipText: { color: "#C3D2DC", fontSize: 12, fontWeight: "700" },
	chipTextSelected: { color: COLORS.accentDark },

	actionDock: { gap: 8, paddingTop: 4 },
	feedback: {
		height: 22,
		flexDirection: "row",
		gap: 8,
		alignItems: "center",
		justifyContent: "center",
	},
	feedbackText: {
		color: COLORS.muted,
		fontSize: 12,
		flexShrink: 1,
		textAlign: "center",
	},
	actions: { flexDirection: "row", gap: 10 },
	onButton: {
		flex: 1.1,
		minHeight: 54,
		backgroundColor: COLORS.accent,
		borderRadius: 14,
		flexDirection: "row",
		justifyContent: "center",
		alignItems: "center",
		gap: 8,
	},
	onButtonText: { color: COLORS.accentDark, fontSize: 16, fontWeight: "800" },
	offButton: {
		flex: 1,
		minHeight: 54,
		borderRadius: 14,
		borderWidth: 1,
		borderColor: COLORS.border,
		backgroundColor: COLORS.surface,
		flexDirection: "row",
		justifyContent: "center",
		alignItems: "center",
		gap: 8,
	},
	offButtonText: { color: COLORS.white, fontSize: 16, fontWeight: "800" },
	buttonDimmed: { opacity: 0.45 },

	modalOverlay: {
		flex: 1,
		justifyContent: "center",
		paddingHorizontal: 26,
		backgroundColor: "rgba(0,0,0,0.72)",
	},
	modalCard: {
		backgroundColor: COLORS.surface,
		padding: 21,
		borderRadius: 20,
		borderWidth: 1,
		borderColor: COLORS.border,
		gap: 15,
	},
	modalTitle: { color: COLORS.white, fontWeight: "800", fontSize: 20 },
	modalDescription: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
	modalInput: {
		color: COLORS.white,
		fontSize: 22,
		fontWeight: "700",
		backgroundColor: COLORS.background,
		borderColor: COLORS.border,
		borderWidth: 1,
		borderRadius: 13,
		paddingVertical: 12,
		paddingHorizontal: 16,
	},
	modalButtons: { flexDirection: "row", gap: 10 },
	modalCancel: {
		flex: 1,
		minHeight: 48,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: COLORS.border,
		alignItems: "center",
		justifyContent: "center",
	},
	modalCancelText: { color: COLORS.white, fontWeight: "700" },
	modalSave: {
		flex: 1,
		minHeight: 48,
		borderRadius: 12,
		backgroundColor: COLORS.accent,
		alignItems: "center",
		justifyContent: "center",
	},
	modalSaveText: { color: COLORS.accentDark, fontWeight: "800" },

	// Login preservado.
	loginContainer: { width: "100%", paddingHorizontal: 27, gap: 16 },
	loginIcon: {
		width: 70,
		height: 70,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: 23,
		backgroundColor: COLORS.surface,
		borderWidth: 1,
		borderColor: COLORS.border,
		marginBottom: 12,
	},
	loginTitle: {
		color: COLORS.white,
		fontSize: 36,
		lineHeight: 42,
		fontWeight: "800",
		letterSpacing: -1.2,
	},
	subtitle: { color: COLORS.muted, lineHeight: 21, fontSize: 15 },
	loginFields: { gap: 12, marginTop: 18 },
	input: {
		color: COLORS.white,
		fontSize: 16,
		backgroundColor: COLORS.surface,
		borderColor: COLORS.border,
		borderWidth: 1,
		padding: 16,
		borderRadius: 15,
	},
	loginButton: {
		backgroundColor: COLORS.accent,
		borderRadius: 16,
		minHeight: 58,
		alignItems: "center",
		justifyContent: "center",
		flexDirection: "row",
		gap: 10,
		marginTop: 5,
	},
	loginButtonText: {
		color: COLORS.accentDark,
		fontWeight: "800",
		fontSize: 16,
	},
	errorText: { color: COLORS.red, fontSize: 13 },

	dashboardTiny: {
		paddingHorizontal: 12,
		paddingTop: 6,
		paddingBottom: 8,
		gap: 8,
	},
});
