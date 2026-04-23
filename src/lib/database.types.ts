export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

type GenericTable = {
  Row: Record<string, any>;
  Insert: Record<string, any>;
  Update: Record<string, any>;
  Relationships: Array<{
    foreignKeyName: string;
    columns: string[];
    isOneToOne: boolean;
    referencedRelation: string;
    referencedColumns: string[];
  }>;
};

export interface Database {
  public: {
    Tables: ({
      commerces: {
        Row: {
          id: string;
          user_id: string;
          nom: string;
          adresse: string | null;
          telephone: string | null;
          email: string | null;
          logo_url: string | null;
          latitude: number | null;
          longitude: number | null;
          rayon_geo: number;
          actif: boolean;
          plan: string | null;
          plan_override: string | null;
          billing_status: string | null;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          trial_ends_at: string | null;
          onboarding_completed: boolean | null;
          onboarding_purchased: boolean | null;
          scanners_count: number | null;
          sms_credits: number | null;
          sms_welcome_enabled: boolean | null;
          sms_welcome_message: string | null;
          sms_review_enabled: boolean | null;
          sms_relance_enabled: boolean | null;
          sms_relance_jours: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['commerces']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          rayon_geo?: number;
          actif?: boolean;
        };
        Update: Partial<Database['public']['Tables']['commerces']['Insert']>;
      };
      points_vente: {
        Row: {
          id: string;
          commerce_id: string;
          nom: string;
          adresse: string | null;
          telephone: string | null;
          email: string | null;
          latitude: number | null;
          longitude: number | null;
          rayon_geo: number;
          actif: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['points_vente']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          rayon_geo?: number;
          actif?: boolean;
        };
        Update: Partial<Database['public']['Tables']['points_vente']['Insert']>;
      };
      cartes: {
        Row: {
          id: string;
          commerce_id: string;
          point_vente_id: string | null;
          nom: string;
          description: string | null;
          type: 'points' | 'tampons';
          tampons_total: number;
          points_par_euro: number;
          points_recompense: number;
          recompense_description: string | null;
          couleur_fond: string;
          couleur_texte: string;
          couleur_accent: string;
          message_geo: string;
          logo_url: string | null;
          strip_url: string | null;
          strip_position: string | null;
          strip_layout: string | null;
          strip_plein_largeur: boolean | null;
          tampon_icon_url: string | null;
          tampon_emoji: string | null;
          tampon_icon_scale: number | null;
          barcode_type: string;
          label_client: string;
          couleur_fond_2: string | null;
          gradient_angle: number | null;
          pattern_type: string | null;
          police: string | null;
          police_taille: number | null;
          police_gras: boolean | null;
          texte_alignement: string | null;
          welcome_message: string | null;
          success_message: string | null;
          rewards_config: Json | null;
          vip_tiers: Json | null;
          review_reward_enabled: boolean | null;
          review_reward_value: number | null;
          google_maps_url: string | null;
          branding_powered_by_enabled: boolean | null;
          push_icon_bg_color: string | null;
          birthday_auto_enabled: boolean | null;
          birthday_reward_value: number | null;
          birthday_push_title: string | null;
          birthday_push_message: string | null;
          pass_type_id: string | null;
          qr_code_url: string | null;
          actif: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['cartes']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          tampons_total?: number;
          points_par_euro?: number;
          points_recompense?: number;
          couleur_fond?: string;
          couleur_texte?: string;
          couleur_accent?: string;
          message_geo?: string;
          actif?: boolean;
        };
        Update: Partial<Database['public']['Tables']['cartes']['Insert']>;
      };
      clients: {
        Row: {
          id: string;
          carte_id: string;
          commerce_id: string;
          point_vente_id: string | null;
          nom: string | null;
          telephone: string | null;
          email: string | null;
          date_naissance: string | null;
          points_actuels: number;
          tampons_actuels: number;
          recompenses_obtenues: number;
          apple_pass_serial: string | null;
          google_pass_id: string | null;
          fcm_token: string | null;
          push_enabled: boolean;
          derniere_visite: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['clients']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          points_actuels?: number;
          tampons_actuels?: number;
          recompenses_obtenues?: number;
          push_enabled?: boolean;
        };
        Update: Partial<Database['public']['Tables']['clients']['Insert']>;
      };
      transactions: {
        Row: {
          id: string;
          client_id: string;
          commerce_id: string;
          point_vente_id: string | null;
          type: 'ajout_points' | 'ajout_tampon' | 'recompense' | 'reset';
          valeur: number;
          points_avant: number | null;
          points_apres: number | null;
          note: string | null;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['transactions']['Row'], 'id' | 'created_at'> & {
          id?: string;
        };
        Update: Partial<Database['public']['Tables']['transactions']['Insert']>;
      };
      notifications: {
        Row: {
          id: string;
          commerce_id: string;
          point_vente_id: string | null;
          titre: string;
          message: string;
          type: string;
          nb_destinataires: number;
          nb_delivrees: number;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['notifications']['Row'], 'id' | 'created_at'> & {
          id?: string;
          type?: string;
          nb_destinataires?: number;
          nb_delivrees?: number;
        };
        Update: Partial<Pick<Database['public']['Tables']['notifications']['Row'], 'nb_delivrees'>>;
      };
      apple_pass_registrations: {
        Row: {
          id: string;
          client_id: string;
          device_library_identifier: string;
          pass_type_identifier: string;
          push_token: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['apple_pass_registrations']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['apple_pass_registrations']['Insert']>;
      };
      birthday_rewards: {
        Row: {
          id: string;
          client_id: string;
          carte_id: string;
          birth_year: number;
          reward_value: number;
          sent_at: string;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['birthday_rewards']['Row'], 'id' | 'sent_at' | 'created_at'> & {
          id?: string;
          sent_at?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['birthday_rewards']['Insert']>;
      };
      review_rewards: {
        Row: {
          id: string;
          client_id: string;
          carte_id: string;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['review_rewards']['Row'], 'id' | 'created_at'> & { id?: string };
        Update: Partial<Database['public']['Tables']['review_rewards']['Insert']>;
      };
      scanner_devices: {
        Row: {
          id: string;
          commerce_id: string;
          point_vente_id: string | null;
          scanner_token: string;
          device_name: string | null;
          user_agent: string | null;
          last_seen_at: string;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['scanner_devices']['Row'], 'id' | 'created_at'> & { id?: string };
        Update: Partial<Database['public']['Tables']['scanner_devices']['Insert']>;
      };
      sms_logs: {
        Row: {
          id: string;
          commerce_id: string;
          client_id: string | null;
          type: string;
          telephone: string;
          message: string;
          statut: string;
          credits_debites: number;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['sms_logs']['Row'], 'id' | 'created_at'> & { id?: string };
        Update: Partial<Database['public']['Tables']['sms_logs']['Insert']>;
      };
      sms_scheduled: {
        Row: {
          id: string;
          commerce_id: string;
          client_id: string | null;
          telephone: string;
          message: string;
          type: string;
          send_at: string;
          sent: boolean;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['sms_scheduled']['Row'], 'id' | 'created_at'> & { id?: string };
        Update: Partial<Database['public']['Tables']['sms_scheduled']['Insert']>;
      };
      stripe_webhook_events: {
        Row: {
          id: string;
          event_id: string;
          event_type: string;
          status: string;
          last_error: string | null;
          processed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['stripe_webhook_events']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          last_error?: string | null;
          processed_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['stripe_webhook_events']['Insert']>;
      };
    } & Record<string, GenericTable>);
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
